package eu.majmohar.isrm

import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.bottomsheet.BottomSheetDialog
import java.net.URL
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {
    private data class ReleaseInfo(val version: String, val releaseUrl: String)
    private val executor = Executors.newSingleThreadExecutor()
    private val slovene = Locale("sl", "SI")
    private val rangeFormat = DateTimeFormatter.ofPattern("d. M.", slovene)
    private val dayFormat = DateTimeFormatter.ofPattern("EEEE, d. MMMM", slovene)
    private lateinit var repo: TimetableRepository
    private lateinit var lessons: LinearLayout
    private lateinit var loading: View
    private lateinit var status: TextView
    private lateinit var subtitle: TextView
    private var week = LocalDate.now().with(DayOfWeek.MONDAY)
    private val prefs by lazy { getSharedPreferences("native-settings", MODE_PRIVATE) }
    private val year get() = prefs.getString("year", "1") ?: "1"
    private val student get() = prefs.getString("student", "") ?: ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        repo = TimetableRepository(this)
        lessons = findViewById(R.id.lessons)
        loading = findViewById(R.id.loading)
        status = findViewById(R.id.status)
        subtitle = findViewById(R.id.week_subtitle)
        findViewById<ImageButton>(R.id.previous).setOnClickListener { week = week.minusWeeks(1); load() }
        findViewById<ImageButton>(R.id.next).setOnClickListener { week = week.plusWeeks(1); load() }
        findViewById<TextView>(R.id.today).setOnClickListener { week = LocalDate.now().with(DayOfWeek.MONDAY); load() }
        findViewById<ImageButton>(R.id.refresh).setOnClickListener { load(true) }
        findViewById<ImageButton>(R.id.settings).setOnClickListener { showSettings() }
        if (android.os.Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { finish() }
        load()
        checkRelease()
    }

    private fun load(manual: Boolean = false) {
        subtitle.text = "${week.format(rangeFormat)} – ${week.plusDays(4).format(rangeFormat)} · $year. letnik"
        val cached = repo.cached(week, year, student)
        render(cached, cached.isEmpty())
        status.text = when { manual -> "Osvežujem urnik"; cached.isEmpty() -> "Nalagam urnik"; else -> "Prikazan je shranjen urnik · osvežujem" }
        executor.execute {
            val attempt = runCatching { repo.refresh(week, year, student) }
            val fresh = attempt.getOrElse { cached }
            runOnUiThread {
                render(fresh, false)
                status.text = when { attempt.isSuccess -> "Posodobljeno zdaj · $year. letnik"; fresh.isNotEmpty() -> "Povezava ni dosegljiva · prikazan shranjen urnik"; else -> "Urnika trenutno ni mogoče naložiti" }
            }
            executor.execute { repo.preload(year, student) }
        }
    }

    private fun render(items: List<Lesson>, showSkeleton: Boolean) {
        loading.visibility = if (showSkeleton) View.VISIBLE else View.GONE
        lessons.visibility = if (showSkeleton) View.GONE else View.VISIBLE
        if (showSkeleton) return
        lessons.removeAllViews()
        var animationOrder = 0
        (0..4).forEach { offset ->
            val day = week.plusDays(offset.toLong())
            lessons.addView(dayHeader(day, day == LocalDate.now()))
            val daily = items.filter { it.date == day.toString() }
            if (daily.isEmpty()) lessons.addView(emptyDay()) else daily.forEach { lessons.addView(lessonCard(it, animationOrder++)) }
        }
    }

    private fun dayHeader(day: LocalDate, today: Boolean) = LinearLayout(this).apply {
        gravity = Gravity.CENTER_VERTICAL
        orientation = LinearLayout.HORIZONTAL
        setPadding(0, dp(26), 0, dp(10))
        addView(label(day.format(dayFormat).replaceFirstChar { it.titlecase(slovene) }, 17f, color(R.color.ink), Typeface.BOLD), LinearLayout.LayoutParams(0, WRAP).apply { weight = 1f })
        if (today) addView(tag("DANES", color(R.color.today_fill), color(R.color.today_text)))
    }

    private fun emptyDay() = TextView(this).apply {
        text = "Brez obveznosti"
        setTextColor(color(R.color.muted))
        textSize = 14f
        setPadding(dp(16), dp(18), dp(16), dp(18))
        background = rounded(color(R.color.empty_fill), color(R.color.divider), 14)
        layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(4) }
    }

    private fun lessonCard(lesson: Lesson, order: Int): View {
        val fri = lesson.source == "FRI"
        val fill = color(if (fri) R.color.fri_fill else R.color.fmf_fill)
        val edge = color(if (fri) R.color.fri_edge else R.color.fmf_edge)
        val accent = color(if (fri) R.color.fri_text else R.color.fmf_text)
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.TOP
            setPadding(dp(15), dp(15), dp(14), dp(14))
            background = rounded(fill, edge, 18)
            isClickable = true
            isFocusable = true
            foreground = selectableForeground()
            contentDescription = "${lesson.title}, ${lesson.start} do ${lesson.end}"
            setOnClickListener { showLesson(lesson, fill, edge, accent) }
            val time = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(label(lesson.start, 14f, accent, Typeface.BOLD).apply { typeface = Typeface.MONOSPACE })
                addView(label(lesson.end, 12f, color(R.color.muted), Typeface.NORMAL).apply { typeface = Typeface.MONOSPACE; setPadding(0, dp(3), 0, 0) })
            }
            addView(time, LinearLayout.LayoutParams(dp(67), WRAP))
            val content = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(label(lesson.title, 17f, color(R.color.ink), Typeface.BOLD).apply { setLineSpacing(0f, 1.04f) })
                val details = listOfNotNull(lesson.type.takeIf { it.isNotBlank() }, lesson.room.takeIf { it.isNotBlank() } ?: "Prostor ni znan").joinToString(" · ")
                addView(label(details, 13f, color(R.color.muted), Typeface.NORMAL).apply { setPadding(0, dp(5), 0, 0) })
                addView(tag(lesson.source, if (fri) color(R.color.fri_tag) else color(R.color.fmf_tag), accent).apply { setPadding(dp(8), dp(4), dp(8), dp(4)); layoutParams = LinearLayout.LayoutParams(WRAP, WRAP).apply { topMargin = dp(11) } })
            }
            addView(content, LinearLayout.LayoutParams(0, WRAP).apply { weight = 1f })
            layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(8) }
            alpha = 0f
            translationY = dp(10).toFloat()
            post { animate().alpha(1f).translationY(0f).setStartDelay((order.coerceAtMost(8) * 28L)).setDuration(230L).setInterpolator(android.view.animation.DecelerateInterpolator()).start() }
        }
    }

    private fun showLesson(lesson: Lesson, fill: Int, edge: Int, accent: Int) {
        val dialog = BottomSheetDialog(this)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(12), dp(24), dp(32))
            setBackgroundColor(color(R.color.canvas))
            addView(View(this@MainActivity).apply { background = rounded(color(R.color.sheet_handle), color(R.color.sheet_handle), 3) }, LinearLayout.LayoutParams(dp(36), dp(4)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(24) })
            addView(tag(lesson.source, if (lesson.source == "FRI") color(R.color.fri_tag) else color(R.color.fmf_tag), accent).apply { layoutParams = LinearLayout.LayoutParams(WRAP, WRAP).apply { bottomMargin = dp(12) } })
            addView(label(lesson.title, 26f, color(R.color.ink), Typeface.BOLD).apply { setLineSpacing(0f, 1.04f) })
            addView(label("${lesson.start}–${lesson.end} · ${lesson.type}", 15f, color(R.color.muted), Typeface.NORMAL).apply { setPadding(0, dp(8), 0, dp(20)) })
            addView(detailRow("PROSTOR", lesson.room.ifBlank { "Ni podatka" }, fill, edge))
            addView(detailRow("IZVAJALEC", lesson.teacher.ifBlank { "Ni podatka" }, fill, edge).apply { layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(8) } })
        }
        dialog.setContentView(content)
        dialog.show()
    }

    private fun detailRow(name: String, value: String, fill: Int, edge: Int) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(15), dp(13), dp(15), dp(14))
        background = rounded(fill, edge, 14)
        addView(label(name, 10f, color(R.color.muted), Typeface.BOLD).apply { letterSpacing = 0.1f })
        addView(label(value, 16f, color(R.color.ink), Typeface.BOLD).apply { setPadding(0, dp(5), 0, 0) })
    }

    private fun showSettings() {
        val dialog = BottomSheetDialog(this)
        val view = layoutInflater.inflate(R.layout.sheet_settings, null)
        val years = view.findViewById<Spinner>(R.id.settings_year)
        val personalNumber = view.findViewById<EditText>(R.id.settings_student)
        years.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, arrayOf("1. letnik", "2. letnik", "3. letnik"))
        years.setSelection(year.toIntOrNull()?.minus(1)?.coerceIn(0, 2) ?: 0)
        personalNumber.setText(student)
        view.findViewById<TextView>(R.id.settings_save).setOnClickListener {
            prefs.edit().putString("year", (years.selectedItemPosition + 1).toString()).putString("student", personalNumber.text.toString().filter(Char::isDigit)).apply()
            dialog.dismiss()
            load()
        }
        dialog.setContentView(view)
        dialog.show()
    }

    private fun label(text: String, size: Float, textColor: Int, style: Int) = TextView(this).apply { this.text = text; setTextColor(textColor); textSize = size; setTypeface(Typeface.create("sans-serif", style)) }
    private fun tag(text: String, fill: Int, textColor: Int) = label(text, 10f, textColor, Typeface.BOLD).apply { gravity = Gravity.CENTER; letterSpacing = 0.08f; background = rounded(fill, fill, 8) }
    private fun rounded(fill: Int, stroke: Int, radius: Int) = GradientDrawable().apply { shape = GradientDrawable.RECTANGLE; cornerRadius = dp(radius).toFloat(); setColor(fill); setStroke(dp(1), stroke) }
    private fun selectableForeground(): android.graphics.drawable.Drawable? { val value = TypedValue(); theme.resolveAttribute(android.R.attr.selectableItemBackground, value, true); return ContextCompat.getDrawable(this, value.resourceId) }
    private fun color(id: Int) = ContextCompat.getColor(this, id)
    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()

    private fun newer(remote: String, local: String): Boolean {
        val a = remote.split('.').map { it.toIntOrNull() ?: 0 }; val b = local.split('.').map { it.toIntOrNull() ?: 0 }
        for (index in 0 until maxOf(a.size, b.size)) { val x = a.getOrElse(index) { 0 }; val y = b.getOrElse(index) { 0 }; if (x != y) return x > y }
        return false
    }

    private fun checkRelease() = executor.execute {
        val update = runCatching { val release = org.json.JSONObject(URL("${BuildConfig.WEB_APP_URL.trimEnd('/')}/api/release").readText()); ReleaseInfo(release.optString("androidVersion"), releasePage(release.optString("androidReleaseUrl"))) }.getOrNull() ?: return@execute
        if (newer(update.version, BuildConfig.VERSION_NAME) && update.releaseUrl.startsWith("https://")) runOnUiThread {
            val separator = if (update.releaseUrl.contains("?")) "&" else "?"
            val destination = "${update.releaseUrl}${separator}installed=${Uri.encode(BuildConfig.VERSION_NAME)}"
            androidx.appcompat.app.AlertDialog.Builder(this).setTitle("Na voljo je posodobitev IŠRM").setMessage("Različica ${update.version} je pripravljena.").setNegativeButton("Kasneje", null).setPositiveButton("Odpri posodobitev") { _, _ -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(destination))) }.show()
        }
    }

    private fun releasePage(configured: String): String { val base = BuildConfig.WEB_APP_URL.trimEnd('/'); return when { configured.startsWith("https://") -> configured; configured.startsWith("/") -> "$base$configured"; else -> "$base/android" } }
    override fun onDestroy() { executor.shutdownNow(); super.onDestroy() }
    private companion object { const val MATCH = LinearLayout.LayoutParams.MATCH_PARENT; const val WRAP = LinearLayout.LayoutParams.WRAP_CONTENT }
}
