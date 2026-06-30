package com.example.rokidvsikea

/**
 * 打字机节奏:把突发/过快的流式 delta 平滑成**纯恒定速度**逐字揭示。
 * 不做"追赶积压"(那会让大块瞬间飙完=之前嫌的太快);就是稳稳每拍吐固定字数,
 * 对齐隔离测试里舒服的慢吐手感(~7 字/秒)。两个旋钮调速。纯逻辑,可单测。
 */
object Typewriter {
    const val TICK_MS = 140L       // 节拍 140ms
    const val CHARS_PER_TICK = 1   // 每拍揭示字数 → 速度 = CHARS_PER_TICK * (1000/TICK_MS) ≈ 7 字/秒
    const val LINGER_MS = 1000L    // 字全部揭示完后,呼吸再陪伴这么久(让用户读完)才收 → IDLE

    /** 本拍应揭示的字符数;0 表示已追平(可停拍)。恒定速度,不随积压加速。 */
    fun step(revealed: Int, target: Int): Int {
        val backlog = target - revealed
        if (backlog <= 0) return 0
        return minOf(CHARS_PER_TICK, backlog)
    }
}
