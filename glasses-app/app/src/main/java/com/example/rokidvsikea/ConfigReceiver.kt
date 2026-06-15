package com.example.rokidvsikea

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 接收 setup 经 adb 注入的后端配置：
 *   adb shell am broadcast -a com.example.rokidvsikea.SET_CONFIG -p com.example.rokidvsikea \
 *     --es url "https://<your-backend>/glasses/chat" --es token "<token>"
 * 校验：url 必须 https；token 非空。不打印 token。
 */
class ConfigReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, i: Intent) {
        val url = i.getStringExtra("url")?.trim().orEmpty()
        val token = i.getStringExtra("token")?.trim().orEmpty()
        if (!url.startsWith("https://")) { Log.w("RodeConfig", "拒绝非 https url"); return }
        if (token.isEmpty()) { Log.w("RodeConfig", "空 token"); return }
        RodeConfig.save(ctx, url, token)
        Log.d("RodeConfig", "配置已写入 (url 长度=${url.length})") // 不打印 token
    }
}
