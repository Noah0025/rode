package com.example.rokidvsikea

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.cos
import kotlin.math.sin

/**
 * 底部状态可视化（绿色单色）：
 *  - IDLE      : 居中提示
 *  - LISTENING : 我说话——右端绿点**长亮不呼吸**、大小跟麦克风音量；**不显 Logo**
 *  - THINKING 识别阶段(showThinking=false): STT 转写中——右端绿点**呼吸** + 左侧「识别中…」；**不显 Logo**
 *  - THINKING 思考阶段(showThinking=true) : Rode 思考——左端 Logo 呼吸 + 左侧「思考中…」
 *  - ANSWER    : Rode 朗读——左端 Logo 呼吸（快）
 */
class WaveformView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    enum class Mode { IDLE, LISTENING, THINKING, ANSWER }

    companion object {
        private const val GREEN = 0xFF45F068.toInt()
        private const val GREEN_DIM = 0xFF2E8B49.toInt()
    }

    var mode: Mode = Mode.IDLE
        set(value) { field = value; if (value != Mode.THINKING) showThinking = false; restartAnim() }

    /** 「思考中…」文字：停下后先只显 Logo，等后端 status(STT 转写完成)才置 true 显文字。 */
    var showThinking: Boolean = false

    var idleHint: String = "单击：说话／发送　　双击：取消／退出"

    /** 实时麦克风音量 0..1（LISTENING 用）。 */
    var amplitudeProvider: (() -> Float)? = null

    private var phase = 0f
    private var breath = 0f
    private var micLevel = 0f
    private val textBounds = Rect()

    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; strokeWidth = 2.4f; color = GREEN; strokeCap = Paint.Cap.ROUND
    }
    private val logoPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; strokeWidth = 2f; color = GREEN
    }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = GREEN }
    private val hintPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        // 12sp 等效（按屏幕密度换算，不再硬编码 px）
        color = GREEN_DIM; textSize = 12f * resources.displayMetrics.density; textAlign = Paint.Align.CENTER
    }

    private var anim: ValueAnimator? = null

    private fun restartAnim() {
        anim?.cancel()
        if (mode == Mode.IDLE) { micLevel = 0f; invalidate(); return }
        val period = when (mode) {
            Mode.THINKING -> 2400L
            Mode.ANSWER -> 850L
            else -> 2200L   // LISTENING 绿点慢呼吸
        }
        anim = ValueAnimator.ofFloat(0f, (Math.PI * 2).toFloat()).apply {
            duration = period; repeatCount = ValueAnimator.INFINITE
            interpolator = LinearInterpolator()
            addUpdateListener {
                phase = it.animatedValue as Float
                breath = (sin(phase.toDouble()).toFloat() + 1f) / 2f
                if (mode == Mode.LISTENING) {
                    val target = amplitudeProvider?.invoke()?.coerceIn(0f, 1f) ?: 0f
                    micLevel = micLevel * 0.7f + target * 0.3f      // 平滑跟随
                }
                invalidate()
            }
            start()
        }
    }

    override fun onDetachedFromWindow() { anim?.cancel(); super.onDetachedFromWindow() }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat(); val h = height.toFloat()
        val y = h * 0.5f
        if (mode == Mode.IDLE) {
            val fm = hintPaint.fontMetrics
            canvas.drawText(idleHint, w / 2f, y - (fm.ascent + fm.descent) / 2f, hintPaint)
            return
        }
        if (mode == Mode.LISTENING) {
            // 我说话：绿点在右侧；**长亮不呼吸**，仅大小跟麦克风音量（更符合"正在采集"的逻辑）
            val r = 6f + micLevel * 7f
            dot.alpha = 255
            canvas.drawCircle(w * 0.88f, y, r, dot)
        } else if (mode == Mode.THINKING && !showThinking) {
            // 识别中（STT 阶段，转写还没回来）：我这侧(右)绿点呼吸 + 紧挨绿点**左侧**「识别中…」，不显 Logo
            // 位置镜像「思考中紧挨左侧 logo」：左锚定，按 3 点最大宽度预留，让文字稳定收在绿点左边、点数变化不抖
            val dotX = w * 0.88f
            val r = 5f + breath * 1.5f
            dot.alpha = (110 + breath * 120).toInt()
            canvas.drawCircle(dotX, y, r, dot)
            val maxW = hintPaint.measureText("识别中 ···")
            drawProgressText(canvas, "识别中", dotX - 14f - maxW, y)
        } else {
            // 思考中 / 朗读：Logo 在左侧，呼吸
            val logoR = 9f + breath * 3f
            logoPaint.alpha = (120 + breath * 135).toInt()
            drawStar(canvas, w * 0.12f, y, logoR)
            if (mode == Mode.THINKING && showThinking) {
                // 思考中：紧挨左侧 Logo 右边写「思考中…」（等转写回来才显）
                drawProgressText(canvas, "思考中", w * 0.18f, y)
            }
        }
    }

    /**
     * 左对齐的「X…」进度文字，随 phase 一起呼吸。
     * 省略号用居中圆点「·」而非半角句号「.」（后者贴基线像英文句号，· 垂直居中才像中文省略号）；
     * 点数随 phase 循环 1→2→3。用固定 label 做 getTextBounds 定中线，点数变化不抖；
     * 墨迹居中(exactCenterY)而非字体 ascent/descent，CJK 才和左侧 Logo/绿点同一水平中线。
     */
    private fun drawProgressText(canvas: Canvas, label: String, x: Float, y: Float) {
        hintPaint.alpha = (120 + breath * 135).toInt()
        hintPaint.textAlign = Paint.Align.LEFT
        val dots = "·".repeat((phase / (Math.PI * 2 / 3)).toInt().coerceIn(0, 2) + 1)
        hintPaint.getTextBounds(label, 0, label.length, textBounds)
        canvas.drawText("$label $dots", x, y - textBounds.exactCenterY(), hintPaint)
        hintPaint.textAlign = Paint.Align.CENTER // 复位，IDLE 提示居中
        hintPaint.alpha = 255
    }

    /** 八角星（Rode logo 占位）。 */
    private fun drawStar(c: Canvas, cx: Float, cy: Float, r: Float) {
        for (i in 0 until 8) {
            val a = Math.PI * i / 4.0
            val rr = if (i % 2 == 0) r else r * 0.5f
            c.drawLine(cx, cy, cx + (cos(a) * rr).toFloat(), cy + (sin(a) * rr).toFloat(), logoPaint)
        }
    }
}
