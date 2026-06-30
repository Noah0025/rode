package com.example.rokidvsikea

import org.junit.Assert.assertEquals
import org.junit.Test

class TypewriterTest {
    @Test
    fun caught_up_returns_zero() {
        assertEquals(0, Typewriter.step(10, 10))
        assertEquals(0, Typewriter.step(12, 10)) // 已超(权威全文更短)也视作追平
    }

    @Test
    fun constant_rate_regardless_of_backlog() {
        // 恒定速度:积压再大每拍也只吐 CHARS_PER_TICK(不追赶 → 不会瞬间飙完)
        assertEquals(Typewriter.CHARS_PER_TICK, Typewriter.step(0, 30))
        assertEquals(Typewriter.CHARS_PER_TICK, Typewriter.step(0, 300))
    }

    @Test
    fun never_overshoots_remaining() {
        assertEquals(1, Typewriter.step(0, 1)) // 剩 1 字只吐 1(不超 backlog)
    }

    @Test
    fun draining_converges_at_constant_rate() {
        var revealed = 0
        val target = 50
        var ticks = 0
        while (revealed < target && ticks < 1000) {
            revealed += Typewriter.step(revealed, target)
            ticks++
        }
        assertEquals(target, revealed)
        assertEquals(target / Typewriter.CHARS_PER_TICK, ticks) // 恒定速率:拍数=长度/每拍字数
    }
}
