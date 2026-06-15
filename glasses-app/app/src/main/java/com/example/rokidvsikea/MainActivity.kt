package com.example.rokidvsikea

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.example.rokidvsikea.databinding.ActivityMainBinding
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity(), RodeClient.Listener {

    private lateinit var binding: ActivityMainBinding
    private var client: RodeClient? = null
    private val transcript: TranscriptStore by lazy { TranscriptStore(applicationContext) }

    companion object {
        private const val TAG = "RodeClient"
        private const val REQ_PERMISSIONS = 1001
        private const val GREEN = 0xFF45F068.toInt()        // 荧光绿（Rode）
        private const val GREEN_DIM = 0xFF7FC99A.toInt()    // 较暗绿（用户）
        private const val SCROLL_STEP = 200
    }

    private val chatUrl: String by lazy { RodeConfig.chatUrl(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        binding.waveform.mode = WaveformView.Mode.IDLE
        binding.waveform.amplitudeProvider = { client?.currentAmplitude() ?: 0f }
        setupStatusBar()
        loadHistory()   // 恢复上次的对话记录（打开 app 不再空白）
        ensureWifi()
        ensurePermissions()
    }

    /** 启动时若 WiFi 关着就开启（眼镜重启后默认关）。已存的网络会自动重连，无需在代码里存密码。
     *  普通 Android 10+ setWifiEnabled 受限返回 false；YodaOS 眼镜可能放行，best-effort。 */
    private fun ensureWifi() {
        try {
            val wm = applicationContext.getSystemService(android.content.Context.WIFI_SERVICE) as android.net.wifi.WifiManager
            if (!wm.isWifiEnabled) {
                @Suppress("DEPRECATION")
                val ok = wm.setWifiEnabled(true)
                Log.d(TAG, "ensureWifi: WiFi was off, setWifiEnabled(true) → $ok")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "ensureWifi failed", t)
        }
    }

    // ─── 底部状态栏：时间 · 电量 · WiFi ──────────────────────────────────────
    private val statusReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(c: android.content.Context?, i: android.content.Intent?) = updateStatusBar()
    }

    // ─── 后端连接探测（驱动链路图标）────────────────────────────────────────
    private val pingScope = kotlinx.coroutines.CoroutineScope(
        kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main)
    private var pingJob: kotlinx.coroutines.Job? = null
    private val backendRoot: String by lazy { chatUrl.substringBefore("/glasses").ifEmpty { chatUrl } + "/" }

    private fun startPing() {
        if (pingJob?.isActive == true) return
        pingJob = pingScope.launch {
            while (isActive) {
                val ok = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                    try {
                        val c = (java.net.URL(backendRoot).openConnection() as java.net.HttpURLConnection).apply {
                            connectTimeout = 1500; readTimeout = 1500; requestMethod = "GET"
                        }
                        val code = c.responseCode; c.disconnect(); code in 200..399
                    } catch (_: Throwable) { false }
                }
                val lvl = wifiLevel()
                binding.sbConn.setImageResource(when (lvl) {
                    -1 -> R.drawable.ic_sb_wifi_off
                    0 -> R.drawable.ic_sb_wifi_0
                    1 -> R.drawable.ic_sb_wifi_1
                    2 -> R.drawable.ic_sb_wifi_2
                    else -> R.drawable.ic_sb_wifi_3
                })
                // 无 WiFi：斜杠图标满 alpha 清晰显示；有 WiFi：亮度表后端可达性
                binding.sbConn.alpha = if (lvl == -1) 1f else if (ok) 1f else 0.28f
                kotlinx.coroutines.delay(4000)
            }
        }
    }

    // WiFi 信号强度：-1=无 WiFi（显示斜杠）；0..3=4 档强度。
    // 已连 WiFi 但 RSSI 不可用 → 3（满格，不误报弱）；无网/非 WiFi → -1（断开）。
    private fun wifiLevel(): Int = try {
        val cm = getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
        val nc = cm.getNetworkCapabilities(cm.activeNetwork)
        if (nc != null && nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)) {
            val rssi = nc.signalStrength  // API29+；Int.MIN_VALUE = 不可用
            if (rssi == Int.MIN_VALUE) 3
            else android.net.wifi.WifiManager.calculateSignalLevel(rssi, 4).coerceIn(0, 3)
        } else -1
    } catch (_: Throwable) { -1 }

    private fun setupStatusBar() {
        val filter = android.content.IntentFilter().apply {
            addAction(android.content.Intent.ACTION_TIME_TICK)
            addAction(android.content.Intent.ACTION_BATTERY_CHANGED)
        }
        registerReceiver(statusReceiver, filter)
        updateStatusBar()
    }

    private fun updateStatusBar() {
        // 时间
        val now = java.util.Calendar.getInstance()
        binding.sbTime.text = String.format("%02d:%02d",
            now.get(java.util.Calendar.HOUR_OF_DAY), now.get(java.util.Calendar.MINUTE))
        // 电量
        val bat = registerReceiver(null, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
        val level = bat?.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = bat?.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, 100) ?: 100
        val pct = if (level >= 0) level * 100 / scale else -1
        binding.sbBatteryPct.text = if (pct >= 0) "$pct" else "--"
        // 充电态切换图标（带闪电）
        val status = bat?.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1) ?: -1
        val plugged = bat?.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val charging = plugged != 0 || status == android.os.BatteryManager.BATTERY_STATUS_CHARGING ||
            status == android.os.BatteryManager.BATTERY_STATUS_FULL
        binding.sbBattery.setImageResource(
            if (charging) R.drawable.ic_sb_battery_charging else R.drawable.ic_sb_battery)
        // 链路图标（后端连接）的状态由 pingLoop 单独驱动
    }

    private fun ensurePermissions() {
        val needed = listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA)
            .filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isEmpty()) startClient()
        else ActivityCompat.requestPermissions(this, needed.toTypedArray(), REQ_PERMISSIONS)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_PERMISSIONS) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                startClient()
            } else appendSystem("麦克风权限被拒，无法说话")
        }
    }

    private fun startClient() {
        if (client == null) client = RodeClient(applicationContext, chatUrl, RodeConfig.token(this), this)
        client?.start()
    }

    override fun onResume() {
        super.onResume()
        startPing()
        if (client != null &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            client?.start()
        }
    }

    override fun onPause() {
        pingJob?.cancel()
        client?.pause()
        super.onPause()
    }

    // 单击=ENTER=动作；双击=BACK=（说话/思考中→取消撤回；否则→退出）；前/后滑=DPAD_DOWN/UP=滚动
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        Log.d(TAG, "onKeyDown code=$keyCode repeat=${event?.repeatCount}")
        when (keyCode) {
            KeyEvent.KEYCODE_ENTER -> { if (event?.repeatCount == 0) client?.onTap(); return true }
            KeyEvent.KEYCODE_DPAD_DOWN -> { binding.scrollView.smoothScrollBy(0, -SCROLL_STEP); return true } // 前滑→看更早
            KeyEvent.KEYCODE_DPAD_UP -> { binding.scrollView.smoothScrollBy(0, SCROLL_STEP); return true }     // 后滑→看更新
            KeyEvent.KEYCODE_BACK -> {
                val st = client?.currentState
                if (st == RodeState.LISTENING || st == RodeState.THINKING) {
                    if (event?.repeatCount == 0) { client?.cancel(); appendSystem("已取消") }
                    return true // 消费,不退出——误触可双击撤回
                }
                // 其它状态(IDLE/SPEAKING)落到 super → 退出
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        try { unregisterReceiver(statusReceiver) } catch (_: Throwable) {}
        pingScope.cancel()
        client?.release()
        client = null
        super.onDestroy()
    }

    // ─── RodeClient.Listener ──────────────────────────────────────────────
    override fun onState(state: RodeState) = runOnUiThread {
        binding.waveform.mode = when (state) {
            RodeState.IDLE -> WaveformView.Mode.IDLE
            RodeState.LISTENING -> WaveformView.Mode.LISTENING
            RodeState.THINKING -> WaveformView.Mode.THINKING
            RodeState.SPEAKING -> WaveformView.Mode.ANSWER
        }
    }

    override fun onUserText(text: String) = runOnUiThread { addTurn(text, isRode = false) }
    override fun onAssistantText(text: String) = runOnUiThread { addTurn(text, isRode = true) }
    override fun onError(message: String) = runOnUiThread { appendSystem(message) }

    // 后端 status(STT 转写完成)到了,此时才显「思考中…」——别在话没转写完就喊思考
    override fun onStatus(text: String) = runOnUiThread { binding.waveform.showThinking = true }

    // 状态栏居中：模型 · 5h用量 · 7d用量（如 "Sonnet · 5h 9% · 7d $42"）
    override fun onMeta(model: String, usage5h: String, usage7d: String) = runOnUiThread {
        val parts = mutableListOf<String>()
        if (model.isNotBlank()) parts += model
        if (usage5h.isNotBlank()) parts += "5h $usage5h"
        if (usage7d.isNotBlank()) parts += "7d $usage7d"
        binding.sbUsage.text = parts.joinToString(" · ")
    }

    /** 实时新增一轮：落盘（必要时插会话分隔线）→ 实时画出分隔线和这轮 → 滚到底。 */
    private fun addTurn(text: String, isRode: Boolean) {
        if (text.isBlank()) return
        val dividerTs = transcript.append(isRode, text)   // 超过会话间隔会插「聊到 X」
        if (dividerTs != null) renderHistoryDivider(dividerTs) // 实时画出，不再要等重开 app
        renderTurn(text, isRode)
        binding.scrollView.post { binding.scrollView.fullScroll(android.view.View.FOCUS_DOWN) }
    }

    /** 把一行对话画到屏幕上（不落盘）；实时新增和加载历史共用。 */
    private fun renderTurn(text: String, isRode: Boolean) {
        if (text.isBlank()) return
        val tv = TextView(this).apply {
            this.text = text
            setTextColor(if (isRode) GREEN else GREEN_DIM)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)   // 正文 12sp
            // 用户=右、Rode=左；不加辉光，低分屏上保清晰
            gravity = if (isRode) Gravity.START else Gravity.END
            setLineSpacing(0f, 1.1f)
        }
        val lp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = 10 }
        binding.conversation.addView(tv, lp)
    }

    /** 打开 app 时恢复上次的对话记录（最近 ~50 轮，含按时间分段的「聊到」分隔线），滚到底显示最新。 */
    private fun loadHistory() {
        val items = transcript.load()
        if (items.isEmpty()) return
        items.forEach { item ->
            when (item) {
                is TranscriptStore.Item.Turn -> renderTurn(item.text, item.isRode)
                is TranscriptStore.Item.Divider -> renderHistoryDivider(item.ts)
            }
        }
        binding.scrollView.post { binding.scrollView.fullScroll(android.view.View.FOCUS_DOWN) }
    }

    /** 历史与本次会话之间的浅色分隔线：—— x月x日xx:xx 聊到 —— */
    private fun renderHistoryDivider(millis: Long) {
        val label = if (millis > 0) {
            val c = java.util.Calendar.getInstance().apply { timeInMillis = millis }
            String.format("—— %d月%d日 %02d:%02d 聊到 ——",
                c.get(java.util.Calendar.MONTH) + 1, c.get(java.util.Calendar.DAY_OF_MONTH),
                c.get(java.util.Calendar.HOUR_OF_DAY), c.get(java.util.Calendar.MINUTE))
        } else "—— 以上为历史 ——"
        val tv = TextView(this).apply {
            text = label
            setTextColor(0xFF2E6B45.toInt())   // 比正文更暗的绿，浅淡不抢眼
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            gravity = Gravity.CENTER
        }
        val lp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = 16; bottomMargin = 4 }
        binding.conversation.addView(tv, lp)
    }

    private fun appendSystem(text: String) {
        val tv = TextView(this).apply {
            this.text = text
            setTextColor(0xFF3E7E55.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            gravity = Gravity.CENTER
        }
        val lp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = 12 }
        binding.conversation.addView(tv, lp)
        binding.scrollView.post { binding.scrollView.fullScroll(android.view.View.FOCUS_DOWN) }
    }
}
