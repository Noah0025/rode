package com.example.rokidvsikea

import android.content.Context
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
) {
    interface Listener {
        fun onState(state: RodeState)
        fun onUserText(text: String)
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

    private var ttsReady = false
    private val tts = TtsSpeaker(
        context,
        onReady = { ok ->
            ttsReady = ok
            // 眼镜无中文 TTS 是已知默认（纯文字显示），不打扰用户，只记日志
            if (!ok) Log.d(TAG, "Chinese TTS unavailable — text-only mode")
        },
        onSpeechDone = { if (state == RodeState.SPEAKING) setState(RodeState.IDLE) }, // rest, don't auto-listen
    )

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
            RodeState.SPEAKING -> { tts.stop(); startListening() } // barge-in → speak again
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
        releaseLocks()
        setState(RodeState.IDLE)
    }

    private fun startListening() {
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
                    "answer" -> {
                        answered = true
                        val text = ev.text ?: ""
                        withContext(Dispatchers.Main) {
                            listener.onAssistantText(text)
                            if (ttsReady) { setState(RodeState.SPEAKING); tts.speak(text) }
                            else setState(RodeState.IDLE) // text-only: rest
                        }
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

    fun release() {
        try { recorder.stop() } catch (_: Throwable) {}
        cancelTimeout()
        tts.shutdown()
        releaseLocks()
        scope.cancel()
    }
}
