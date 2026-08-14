package com.helm.rode

import android.content.Context

/**
 * 运行时配置：URL + token 优先读 SharedPreferences（由 ConfigReceiver 经 adb broadcast 写入），
 * 为空则回退到 BuildConfig（dev 编译期值）。公开版没有 app 内配对界面，配置由 setup 经 adb 注入。
 */
object RodeConfig {
    private const val PREFS = "rode_config"

    /** 纯逻辑：prefs 非空优先，否则 fallback。可单测。 */
    fun pick(pref: String?, fallback: String): String = if (!pref.isNullOrBlank()) pref else fallback
    fun pickBoolean(pref: Boolean?, fallback: Boolean): Boolean = pref ?: fallback

    fun chatUrl(ctx: Context): String = pick(sp(ctx).getString("chat_url", null), BuildConfig.GLASSES_CHAT_URL)
    fun token(ctx: Context): String = pick(sp(ctx).getString("token", null), BuildConfig.GLASSES_TOKEN)
    /** 默认开启；服务器关闭 TTS 时不会发事件，因此没有额外副作用。 */
    fun ttsEnabled(ctx: Context): Boolean {
        val prefs = sp(ctx)
        return pickBoolean(if (prefs.contains("tts_enabled")) prefs.getBoolean("tts_enabled", true) else null, true)
    }
    fun save(ctx: Context, url: String, token: String, ttsEnabled: Boolean? = null) {
        val edit = sp(ctx).edit().putString("chat_url", url).putString("token", token)
        if (ttsEnabled != null) edit.putBoolean("tts_enabled", ttsEnabled)
        edit.apply()
    }

    private fun sp(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
