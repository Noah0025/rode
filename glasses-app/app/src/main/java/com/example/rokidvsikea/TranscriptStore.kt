package com.example.rokidvsikea

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * 本地持久化对话记录（用户 / Rode 文本 + 会话间的时间戳分隔线），打开 app 时恢复显示。
 * 只存文本，不存音频 / 图片 / 系统提示（「已取消」「超时了」这类瞬时消息不入库）。
 *
 * 分段：当两次发言间隔超过 SESSION_GAP_MS（10 分钟，视作上一段会话已结束、这是新会话），
 * 在下一句前自动插入一条分隔线，标注上一段「聊到」的时刻——历史因此按时间分段，
 * 一眼能看出每段话是什么时候说的，而不是只知道最后一次。
 *
 * 上限：最多保留约 50 轮（maxLines 行，一问一答=2 行），超出按时间裁掉最旧的；分隔线不计入行数。
 */
class TranscriptStore(context: Context, private val maxLines: Int = 100) {

    sealed class Item {
        data class Turn(val isRode: Boolean, val text: String) : Item()
        data class Divider(val ts: Long) : Item()
    }

    private val prefs = context.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    fun load(): List<Item> {
        val raw = prefs.getString(KEY, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).map {
                val o = arr.getJSONObject(it)
                if (o.optString("k") == "d") Item.Divider(o.getLong("ts"))
                else Item.Turn(o.getBoolean("r"), o.getString("t")) // 兼容旧格式（无 "k" 字段）
            }
        } catch (_: Throwable) {
            emptyList() // 损坏就当空，不崩
        }
    }

    /**
     * 追加一行；若距上次发言已超过会话间隔，先插入一条「聊到 上次时刻」的分隔线。
     * 返回插入的分隔线时刻（毫秒）供 UI 实时画出；没插则返回 null。
     */
    fun append(isRode: Boolean, text: String): Long? {
        if (text.isBlank()) return null
        val items = load().toMutableList()
        val now = System.currentTimeMillis()
        val lastTs = prefs.getLong(KEY_TS, 0L)
        var dividerTs: Long? = null
        if (lastTs > 0 && items.isNotEmpty() && now - lastTs >= SESSION_GAP_MS) {
            items.add(Item.Divider(lastTs)) // 上一段会话聊到 lastTs
            dividerTs = lastTs
        }
        items.add(Item.Turn(isRode, text))
        trim(items)
        save(items, now)
        // 若裁剪把刚插的分隔线丢了(极少,触及上限时)，就别让 UI 画一条存储里没有的线
        return if (dividerTs != null && items.any { it is Item.Divider && it.ts == dividerTs }) dividerTs else null
    }

    fun clear() = prefs.edit().remove(KEY).remove(KEY_TS).apply()

    /** 按 Turn 行数裁到上限（分隔线不计），并去掉裁剪后开头孤立的分隔线。 */
    private fun trim(items: MutableList<Item>) {
        var turns = items.count { it is Item.Turn }
        while (turns > maxLines && items.isNotEmpty()) {
            if (items.removeAt(0) is Item.Turn) turns--
        }
        while (items.isNotEmpty() && items.first() is Item.Divider) items.removeAt(0)
    }

    private fun save(items: List<Item>, ts: Long) {
        val arr = JSONArray()
        items.forEach {
            when (it) {
                is Item.Turn -> arr.put(JSONObject().put("k", "t").put("r", it.isRode).put("t", it.text))
                is Item.Divider -> arr.put(JSONObject().put("k", "d").put("ts", it.ts))
            }
        }
        prefs.edit().putString(KEY, arr.toString()).putLong(KEY_TS, ts).apply()
    }

    companion object {
        private const val PREF = "rode_transcript"
        private const val KEY = "lines"
        private const val KEY_TS = "lines_ts"
        private const val SESSION_GAP_MS = 10 * 60 * 1000L // 间隔 > 10 分钟视作新会话，插时间戳分隔线
    }
}
