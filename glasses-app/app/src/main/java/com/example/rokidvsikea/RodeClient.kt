package com.example.rokidvsikea

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.PowerManager
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.util.concurrent.TimeUnit

enum class RodeState { IDLE, LISTENING, THINKING, SPEAKING }

/**
 * Turn model for the Rokid touchpad (temple-hold is reserved by the system AI, unusable):
 *   - Entering the app rests at IDLE (mic off) — nothing happens until you tap.
 *   - Single tap (KEYCODE_ENTER) is the one action button:
 *       IDLE      → start listening
 *       LISTENING → stop & send
 *       THINKING  → cancel → IDLE
 *       SPEAKING  → barge-in (stop TTS) AND start listening
 *   - After an answer (or TTS), returns to IDLE — it does NOT auto-listen.
 *   - Double tap (KEYCODE_BACK) exits (handled by the Activity).
 * Mic is open ONLY in LISTENING, so TTS never feeds back into STT.
 */
class RodeClient(
    private val context: Context,
    private val chatUrl: String,
    private val token: String,
    private val listener: Listener,
    private val ttsEnabled: Boolean = true,
) {
    interface Listener {
        fun onState(state: RodeState)
        fun onUserText(text: String)
        /** 流式增量块：追加到当前正在生成的 Rode 行（不落盘）。 */
        fun onAssistantDelta(text: String)
        /** 终态完整答案：定稿当前 Rode 行并落盘（流式收尾；非流式时新建一行）。 */
        fun onAssistantText(text: String)
        fun onError(message: String)
        /** 后端状态事件（STT 转写完成后发「思考中」）；用于此时才显思考中文字。 */
        fun onStatus(text: String)
        /** 状态栏元信息（模型 · 5h用量 · 7d用量），随每轮 SSE 下发。 */
        fun onMeta(model: String, usage5h: String, usage7d: String)
    }

    companion object {
        private const val TAG = "RodeClient"
        private const val THINK_TIMEOUT_MS = 45_000L // patch I2: turn safety timeout（whisper 重载+Claude 留余量）
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val http = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS) // 公网 Funnel TLS 握手慢容错
        .readTimeout(0, TimeUnit.SECONDS) // SSE: no read timeout
        .retryOnConnectionFailure(true)
        .build()
    private val recorder = WavRecorder()

    private val tts = TtsSpeaker() // 仅保留耳标提示音；回答播放走下方 MediaPlayer。
    private var mediaPlayer: MediaPlayer? = null
    private var mediaPlaybackActive = false
    // 分句流式播放队列：tts_seg 按到达顺序入队，播完一段自动接下一段；tts_end 后队列播空回 IDLE。
    private val ttsQueue = ArrayDeque<String>()
    private var ttsStreamEnded = false

    @Volatile private var state: RodeState = RodeState.IDLE
    private var turnJob: Job? = null
    private var timeoutTimer: java.util.Timer? = null

    private val wakeLock = (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "rode:turn")
    private val wifiLock = (context.getSystemService(Context.WIFI_SERVICE) as WifiManager)
        .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "rode:turn")

    val currentState get() = state

    /** 实时麦克风音量 0..1，供波形可视化（仅 LISTENING 有意义）。 */
    fun currentAmplitude(): Float = recorder.amplitude

    private fun setState(s: RodeState) {
        Log.d(TAG, "state→$s") // 诊断:状态切换时间线(排查呼吸时序)
        state = s
        listener.onState(s)
    }

    /** Called when the app becomes active. Rests at IDLE (no auto-listen). */
    fun start() {
        if (state == RodeState.IDLE) setState(RodeState.IDLE) // refresh prompt
    }

    /** Single tap (KEYCODE_ENTER) — the one action button. */
    fun onTap() {
        Log.d(TAG, "onTap in state=$state")
        when (state) {
            RodeState.IDLE -> startListening()
            RodeState.LISTENING -> stopListeningAndSend()
            RodeState.THINKING -> { cancelTurn(); setState(RodeState.IDLE) }
            RodeState.SPEAKING -> { stopAudioPlayback(); startListening() } // barge-in → stop MP3 and speak again
        }
    }

    /** UI 把答案逐字揭示完后调用：结束朗读态回 IDLE（无 TTS 的文字流式收尾，让呼吸持续到字显示完）。 */
    fun onAnswerRendered() {
        if (!mediaPlaybackActive && (state == RodeState.SPEAKING || state == RodeState.THINKING)) {
            setState(RodeState.IDLE)
        }
    }

    /** 双击取消：说话中丢弃录音 / 思考中取消请求，回 IDLE（不发给后端）。供误触撤回。 */
    fun cancel() {
        when (state) {
            RodeState.LISTENING -> {
                try { recorder.stop() } catch (_: Throwable) {}
                releaseLocks(); tts.earcon(); setState(RodeState.IDLE)
            }
            RodeState.THINKING -> { cancelTurn(); setState(RodeState.IDLE) }
            else -> {}
        }
    }

    /** App paused/backgrounded — stop the mic and let go of locks. */
    fun pause() {
        try { recorder.stop() } catch (_: Throwable) {}
        cancelTimeout()
        turnJob?.cancel()
        turnJob = null
        stopAudioPlayback()
        releaseLocks()
        setState(RodeState.IDLE)
    }

    private fun startListening() {
        stopAudioPlayback()
        turnJob?.cancel(); turnJob = null   // 取消上一轮残留的 SSE（多条流式后）
        cancelTimeout()
        acquireLocks()
        tts.earcon()
        recorder.start()
        setState(RodeState.LISTENING)
    }

    private fun stopListeningAndSend() {
        val wav = recorder.stop()
        releaseLocks()
        if (wav.isEmpty()) {
            // patch I1: too short / empty → back to IDLE
            listener.onError(context.getString(R.string.err_no_speech))
            setState(RodeState.IDLE)
            return
        }
        setState(RodeState.THINKING)
        resetTtsQueue() // 新一轮：清上一轮残留的段队列与结束标记
        tts.earcon()
        armTimeout()
        turnJob = scope.launch {
            try {
                postAndStream(wav)
            } catch (t: Throwable) {
                Log.e(TAG, "turn failed", t)
                withContext(Dispatchers.Main) {
                    listener.onError(context.getString(R.string.err_backend_unreachable))
                    if (state == RodeState.THINKING) setState(RodeState.IDLE)
                }
            } finally {
                cancelTimeout()
            }
        }
    }

    private fun cancelTurn() {
        turnJob?.cancel()
        turnJob = null
        cancelTimeout()
    }

    // patch I2: if no terminal event arrives within THINK_TIMEOUT_MS, bail out of THINKING.
    private fun armTimeout() {
        cancelTimeout()
        timeoutTimer = java.util.Timer().also {
            it.schedule(object : java.util.TimerTask() {
                override fun run() {
                    if (state == RodeState.THINKING) {
                        turnJob?.cancel()
                        listener.onError(context.getString(R.string.err_timeout))
                        setState(RodeState.IDLE)
                    }
                }
            }, THINK_TIMEOUT_MS)
        }
    }

    private fun cancelTimeout() {
        timeoutTimer?.cancel()
        timeoutTimer = null
    }

    private suspend fun postAndStream(wav: ByteArray) = withContext(Dispatchers.IO) {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("audio", "audio.wav", wav.toRequestBody("audio/wav".toMediaType()))
            .build()
        val request = Request.Builder().url(chatUrl).post(body).apply {
            if (token.isNotEmpty()) header("Authorization", "Bearer $token")
        }.build()

        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("HTTP ${response.code}")
            val source = response.body?.source() ?: throw IllegalStateException("empty body")
            var answered = false
            while (!source.exhausted()) {
                val line = source.readUtf8Line() ?: break
                val ev = parseSseDataLine(line) ?: continue
                when (ev.type) {
                    "user" -> withContext(Dispatchers.Main) { listener.onUserText(ev.text ?: "") }
                    "status" -> withContext(Dispatchers.Main) { listener.onStatus(ev.text ?: "") } // STT 转写完成,此时才显思考中
                    "meta" -> withContext(Dispatchers.Main) {
                        listener.onMeta(ev.model ?: "", ev.usage5h ?: "", ev.usage7d ?: "")
                    }
                    "answer_delta" -> {
                        answered = true
                        val d = ev.text ?: ""
                        withContext(Dispatchers.Main) {
                            if (state != RodeState.SPEAKING) setState(RodeState.SPEAKING) // 进入回答态(波形)
                            listener.onAssistantDelta(d) // 追加同一行,不落盘、不 TTS(等终态全文)
                        }
                    }
                    "answer" -> {
                        answered = true
                        val text = ev.text ?: ""
                        withContext(Dispatchers.Main) {
                            listener.onAssistantText(text) // 定稿+落盘(流式收尾;非流式则新建行)
                            // 不在此朗读：等待后端紧随其后的 tts URL。无 TTS 时保持回答态，
                            // 再由 onAnswerRendered() 回 IDLE——否则字还在蹦、呼吸就没了。
                        }
                    }
                    "tts" -> if (ttsEnabled) { // 兼容旧后端的整段事件：等价单段入队
                        val url = ev.url.orEmpty()
                        withContext(Dispatchers.Main) { enqueueTtsSegment(url); ttsStreamEnded = true }
                    }
                    "tts_seg" -> if (ttsEnabled) {
                        val url = ev.url.orEmpty()
                        withContext(Dispatchers.Main) { enqueueTtsSegment(url) }
                    }
                    "tts_end" -> if (ttsEnabled) withContext(Dispatchers.Main) {
                        ttsStreamEnded = true
                        // 全部段已到且队列播空（或没有任何段）→ 收尾回 IDLE
                        if (!mediaPlaybackActive && ttsQueue.isEmpty() && state == RodeState.SPEAKING) setState(RodeState.IDLE)
                    }
                    "error" -> withContext(Dispatchers.Main) {
                        listener.onError(ev.text ?: context.getString(R.string.err_generic))
                        setState(RodeState.IDLE)
                    }
                    "done" -> { if (!answered) withContext(Dispatchers.Main) { setState(RodeState.IDLE) } }
                }
            }
            // patch I2: stream closed without a terminal event → don't deadlock; rest.
            if (!answered && state == RodeState.THINKING) {
                withContext(Dispatchers.Main) {
                    listener.onError(context.getString(R.string.err_disconnected))
                    setState(RodeState.IDLE)
                }
            }
        }
    }

    private fun acquireLocks() {
        try { if (!wakeLock.isHeld) wakeLock.acquire(60_000L) } catch (_: Throwable) {}
        try { if (!wifiLock.isHeld) wifiLock.acquire() } catch (_: Throwable) {}
    }

    private fun releaseLocks() {
        try { if (wakeLock.isHeld) wakeLock.release() } catch (_: Throwable) {}
        try { if (wifiLock.isHeld) wifiLock.release() } catch (_: Throwable) {}
    }

    /** 新一轮开始/打断时清空播放管线。 */
    private fun resetTtsQueue() {
        ttsQueue.clear()
        ttsStreamEnded = false
    }

    /** 分段入队：空闲则立即起播，正在播则排队等 onCompletion 接力。 */
    private fun enqueueTtsSegment(url: String) {
        if (url.isBlank()) return
        ttsQueue.addLast(url)
        if (!mediaPlaybackActive) playNextSegment()
    }

    private fun playNextSegment() {
        val url = ttsQueue.removeFirstOrNull() ?: run {
            // 队列空：全部段已宣告结束才收尾，否则保持 SPEAKING 等下一段到达
            if (ttsStreamEnded && state == RodeState.SPEAKING) setState(RodeState.IDLE)
            return
        }
        playTts(url)
    }

    /** 解析后端同源 URL，携带聊天使用的同一 token 异步播放。 */
    private fun playTts(url: String) {
        if (url.isBlank()) return
        val resolved = try { chatUrl.toHttpUrl().resolve(url)?.toString() } catch (_: Throwable) { null }
        if (resolved == null) {
            Log.w(TAG, "invalid TTS url")
            playNextSegment() // 坏段跳过，别卡住队列
            return
        }
        stopCurrentPlayer() // 只停当前段，不清队列（清队列属于 barge-in/新轮）
        val player = MediaPlayer()
        mediaPlayer = player
        mediaPlaybackActive = true // prepare 阶段也属于 SPEAKING，单击可立即打断。
        setState(RodeState.SPEAKING)
        try {
            player.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            val headers = if (token.isEmpty()) emptyMap() else mapOf("Authorization" to "Bearer $token")
            player.setDataSource(context, Uri.parse(resolved), headers)
            player.setOnPreparedListener { ready ->
                if (mediaPlayer === ready && mediaPlaybackActive) ready.start()
            }
            player.setOnCompletionListener { finishAudioPlayback(it) }
            player.setOnErrorListener { failed, what, extra ->
                Log.w(TAG, "TTS playback failed: what=$what extra=$extra")
                finishAudioPlayback(failed)
                true
            }
            player.prepareAsync()
        } catch (t: Throwable) {
            Log.w(TAG, "TTS playback setup failed", t)
            finishAudioPlayback(player)
        }
    }

    private fun finishAudioPlayback(player: MediaPlayer) {
        if (mediaPlayer !== player) {
            try { player.release() } catch (_: Throwable) {}
            return
        }
        mediaPlayer = null
        mediaPlaybackActive = false
        try { player.release() } catch (_: Throwable) {}
        playNextSegment() // 接力下一段；队列空则由它决定是否回 IDLE
    }

    /** 只停当前段播放器，不动队列（段间切换用）。 */
    private fun stopCurrentPlayer() {
        val player = mediaPlayer ?: run { mediaPlaybackActive = false; return }
        mediaPlayer = null
        mediaPlaybackActive = false
        try {
            player.setOnPreparedListener(null)
            player.setOnCompletionListener(null)
            player.setOnErrorListener(null)
            player.stop()
        } catch (_: Throwable) {
        } finally {
            try { player.release() } catch (_: Throwable) {}
        }
    }

    /** 整体停止（barge-in/新轮/释放）：停当前段 + 清队列。 */
    private fun stopAudioPlayback() {
        resetTtsQueue()
        stopCurrentPlayer()
    }

    fun release() {
        try { recorder.stop() } catch (_: Throwable) {}
        cancelTimeout()
        stopAudioPlayback()
        tts.shutdown()
        releaseLocks()
        scope.cancel()
    }
}
