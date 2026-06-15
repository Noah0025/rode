package com.example.rokidvsikea

import org.json.JSONObject

/** One backend SSE event. Mirrors the glasses protocol: user/status/answer/done/error/meta. */
data class SseEvent(
    val type: String,
    val text: String?,
    // type=meta 时携带（状态栏：模型 · 5h用量 · 7d用量）
    val model: String? = null,
    val usage5h: String? = null,
    val usage7d: String? = null,
)

/** Parses a single SSE line. Returns null for blanks, comments, and non-`data:` lines. */
fun parseSseDataLine(line: String): SseEvent? {
    val trimmed = line.trim()
    if (!trimmed.startsWith("data: ")) return null
    return try {
        val json = JSONObject(trimmed.substring(6))
        val type = json.optString("type", "")
        if (type.isEmpty()) return null
        val text = if (json.has("text")) json.optString("text") else null
        SseEvent(
            type = type,
            text = text,
            model = if (json.has("model")) json.optString("model") else null,
            usage5h = if (json.has("usage5h")) json.optString("usage5h") else null,
            usage7d = if (json.has("usage7d")) json.optString("usage7d") else null,
        )
    } catch (_: Throwable) { null }
}
