package eu.majmohar.isrm

import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridLayout
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
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {
    private enum class ViewMode(val title: String) { AGENDA("Seznam"), TIMELINE("Časovni"), WEEK("Teden"), MONTH("Mesec") }
    private data class TimedLesson(val lesson: Lesson, val start: Int, val end: Int, val column: Int, val columns: Int)
    private data class ReleaseInfo(val version: String, val releaseUrl: String)

    private val executor = Executors.newSingleThreadExecutor()
    private val slovene = Locale("sl", "SI")
    private val rangeFormat = DateTimeFormatter.ofPattern("d. M.", slovene)
    private val dayFormat = DateTimeFormatter.ofPattern("EEEE, d. MMMM", slovene)
    private val monthFormat = DateTimeFormatter.ofPattern("LLLL yyyy", slovene)
    private val prefs by lazy { getSharedPreferences("native-settings", MODE_PRIVATE) }
    private val year get() = prefs.getString("year", "1") ?: "1"
    private val student get() = prefs.getString("student", "") ?: ""
    private lateinit var repo: TimetableRepository
    private lateinit var content: FrameLayout
    private lateinit var loading: View
    private lateinit var status: TextView
    private lateinit var subtitle: TextView
    private lateinit var viewModes: LinearLayout
    private var week = LocalDate.now().with(DayOfWeek.MONDAY)
    private var monthAnchor = LocalDate.now().withDayOfMonth(1)
    private var timelineDayIndex = (LocalDate.now().dayOfWeek.value - 1).coerceIn(0, 4)
    private var mode = ViewMode.AGENDA
    private var weekEvents: List<Lesson> = emptyList()
    private var monthEvents: List<Lesson> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        // Preferences need an attached Context, so the saved view is read here rather than in a field initializer.
        mode = ViewMode.entries.firstOrNull { it.name == prefs.getString("view", ViewMode.AGENDA.name) } ?: ViewMode.AGENDA
        repo = TimetableRepository(this)
        content = findViewById(R.id.content)
        loading = findViewById(R.id.loading)
        status = findViewById(R.id.status)
        subtitle = findViewById(R.id.week_subtitle)
        viewModes = findViewById(R.id.view_modes)
        buildViewSwitcher()
        attachSwipeNavigation()

        findViewById<ImageButton>(R.id.previous).setOnClickListener { movePeriod(false) }
        findViewById<ImageButton>(R.id.next).setOnClickListener { movePeriod(true) }
        findViewById<TextView>(R.id.today).setOnClickListener { goToday() }
        findViewById<ImageButton>(R.id.refresh).setOnClickListener { if (mode == ViewMode.MONTH) loadMonth(true) else loadWeek(true) }
        findViewById<ImageButton>(R.id.settings).setOnClickListener { showSettings() }
        if (android.os.Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { finish() }
        if (mode == ViewMode.MONTH) loadMonth() else loadWeek()
        checkRelease()
    }

    private fun buildViewSwitcher() {
        viewModes.removeAllViews()
        ViewMode.entries.forEach { candidate ->
            viewModes.addView(TextView(this).apply {
                text = candidate.title
                gravity = Gravity.CENTER
                setPadding(dp(17), 0, dp(17), 0)
                textSize = 13f
                setTypeface(Typeface.create("sans-serif", Typeface.BOLD))
                isClickable = true
                isFocusable = true
                setOnClickListener { selectMode(candidate) }
                tag = candidate
                layoutParams = LinearLayout.LayoutParams(WRAP, MATCH).apply { rightMargin = dp(7) }
            })
        }
        updateViewSwitcher()
    }

    private fun updateViewSwitcher() {
        repeat(viewModes.childCount) { index ->
            val button = viewModes.getChildAt(index) as TextView
            val selected = button.tag == mode
            button.setTextColor(color(if (selected) R.color.on_accent else R.color.muted))
            button.background = rounded(color(if (selected) R.color.accent else R.color.surface), color(if (selected) R.color.accent else R.color.surface_edge), 13)
        }
    }

    private fun selectMode(next: ViewMode) {
        if (mode == next) return
        mode = next
        prefs.edit().putString("view", next.name).apply()
        updateViewSwitcher()
        if (next == ViewMode.MONTH) {
            monthAnchor = week.withDayOfMonth(1)
            loadMonth()
        } else {
            updateSubtitle()
            renderWeek(weekEvents, false)
        }
    }

    private fun attachSwipeNavigation() {
        val detector = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(event: MotionEvent) = true
            override fun onFling(start: MotionEvent?, end: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
                val first = start ?: return false
                val horizontal = end.x - first.x
                if (abs(horizontal) < dp(64) || abs(horizontal) < abs(end.y - first.y) || abs(velocityX) < 360f) return false
                if (mode == ViewMode.TIMELINE) moveTimelineDay(horizontal < 0) else movePeriod(horizontal < 0)
                return true
            }
        })
        content.setOnTouchListener { _, event -> detector.onTouchEvent(event); false }
    }

    private fun moveTimelineDay(forward: Boolean) {
        if (forward && timelineDayIndex < 4) {
            timelineDayIndex += 1
            renderWeek(weekEvents, false)
        } else if (!forward && timelineDayIndex > 0) {
            timelineDayIndex -= 1
            renderWeek(weekEvents, false)
        } else {
            week = if (forward) week.plusWeeks(1) else week.minusWeeks(1)
            timelineDayIndex = if (forward) 0 else 4
            loadWeek()
        }
    }

    private fun movePeriod(forward: Boolean) {
        if (mode == ViewMode.MONTH) {
            monthAnchor = if (forward) monthAnchor.plusMonths(1).withDayOfMonth(1) else monthAnchor.minusMonths(1).withDayOfMonth(1)
            loadMonth()
        } else {
            week = if (forward) week.plusWeeks(1) else week.minusWeeks(1)
            loadWeek()
        }
    }

    private fun goToday() {
        if (mode == ViewMode.MONTH) {
            monthAnchor = LocalDate.now().withDayOfMonth(1)
            loadMonth()
        } else {
            week = LocalDate.now().with(DayOfWeek.MONDAY)
            timelineDayIndex = (LocalDate.now().dayOfWeek.value - 1).coerceIn(0, 4)
            loadWeek()
        }
    }

    private fun updateSubtitle() {
        subtitle.text = if (mode == ViewMode.MONTH) "${monthAnchor.format(monthFormat).replaceFirstChar { it.titlecase(slovene) }} · $year. letnik" else "${week.format(rangeFormat)} – ${week.plusDays(4).format(rangeFormat)} · $year. letnik"
    }

    private fun loadWeek(manual: Boolean = false) {
        if (mode == ViewMode.MONTH) return loadMonth(manual)
        updateSubtitle()
        val cached = repo.cached(week, year, student)
        weekEvents = cached
        renderWeek(cached, cached.isEmpty())
        status.text = when { manual -> "Osvežujem urnik"; cached.isEmpty() -> "Nalagam urnik"; else -> "Prikazan je shranjen urnik · osvežujem" }
        executor.execute {
            val attempt = runCatching { repo.refresh(week, year, student) }
            val fresh = attempt.getOrElse { cached }
            runOnUiThread {
                weekEvents = fresh
                renderWeek(fresh, false)
                status.text = when { attempt.isSuccess -> "Posodobljeno zdaj · $year. letnik"; fresh.isNotEmpty() -> "Povezava ni dosegljiva · prikazan shranjen urnik"; else -> "Urnika trenutno ni mogoče naložiti" }
            }
            executor.execute { repo.preload(year, student) }
        }
    }

    private fun loadMonth(manual: Boolean = false) {
        updateSubtitle()
        val cached = repo.monthCached(monthAnchor, year, student)
        monthEvents = cached
        renderMonth(cached, cached.isEmpty())
        status.text = when { manual -> "Osvežujem mesec"; cached.isEmpty() -> "Nalagam mesec"; else -> "Prikazan je shranjen mesec · osvežujem" }
        executor.execute {
            val attempt = runCatching { repo.refreshMonth(monthAnchor, year, student) }
            val fresh = attempt.getOrElse { cached }
            runOnUiThread {
                monthEvents = fresh
                renderMonth(fresh, false)
                status.text = when { attempt.isSuccess -> "Posodobljeno zdaj · ${monthAnchor.format(DateTimeFormatter.ofPattern("LLLL", slovene))}"; fresh.isNotEmpty() -> "Povezava ni dosegljiva · prikazan shranjen mesec"; else -> "Mesečnega urnika trenutno ni mogoče naložiti" }
            }
        }
    }

    private fun renderWeek(items: List<Lesson>, skeleton: Boolean) {
        showContent(if (skeleton) null else when (mode) {
            ViewMode.AGENDA -> agendaView(items)
            ViewMode.TIMELINE -> timelineView(items)
            ViewMode.WEEK -> weekBoard(items)
            ViewMode.MONTH -> monthView(monthEvents)
        }, skeleton)
    }

    private fun renderMonth(items: List<Lesson>, skeleton: Boolean) = showContent(if (skeleton) null else monthView(items), skeleton)

    private fun showContent(view: View?, skeleton: Boolean) {
        loading.visibility = if (skeleton) View.VISIBLE else View.GONE
        content.visibility = if (skeleton) View.GONE else View.VISIBLE
        if (skeleton) return
        content.removeAllViews()
        content.addView(view, FrameLayout.LayoutParams(MATCH, WRAP))
    }

    private fun agendaView(items: List<Lesson>) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        var order = 0
        (0..4).forEach { offset ->
            val day = week.plusDays(offset.toLong())
            addView(dayHeader(day, day == LocalDate.now()))
            val daily = items.filter { it.date == day.toString() }
            if (daily.isEmpty()) addView(emptyDay()) else daily.forEach { addView(lessonCard(it, order++)) }
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
        setTextColor(color(R.color.muted)); textSize = 14f
        setPadding(dp(16), dp(18), dp(16), dp(18))
        background = rounded(color(R.color.empty_fill), color(R.color.divider), 14)
        layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(4) }
    }

    private fun timelineView(items: List<Lesson>) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(timelineDayPicker())
        val day = week.plusDays(timelineDayIndex.toLong())
        addView(dayHeader(day, day == LocalDate.now()))
        addView(timeGrid(items.filter { it.date == day.toString() }))
    }

    private fun timelineDayPicker() = LinearLayout(this).apply {
        gravity = Gravity.CENTER
        setPadding(0, dp(18), 0, 0)
        (0..4).forEach { index ->
            val day = week.plusDays(index.toLong())
            addView(TextView(this@MainActivity).apply {
                text = "${day.format(DateTimeFormatter.ofPattern("EEE", slovene)).replaceFirstChar { it.titlecase(slovene) }}\n${day.dayOfMonth}"
                gravity = Gravity.CENTER; setLines(2); textSize = 12f
                setTypeface(Typeface.create("sans-serif", Typeface.BOLD))
                val selected = index == timelineDayIndex
                setTextColor(color(if (selected) R.color.on_accent else R.color.muted))
                background = rounded(color(if (selected) R.color.accent else R.color.surface), color(if (selected) R.color.accent else R.color.surface_edge), 12)
                isClickable = true; isFocusable = true
                setOnClickListener { timelineDayIndex = index; renderWeek(weekEvents, false) }
            }, LinearLayout.LayoutParams(0, dp(47)).apply { weight = 1f; if (index != 4) rightMargin = dp(5) })
        }
    }

    private fun timeGrid(items: List<Lesson>) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        val hourHeight = dp(64)
        val firstHour = 7
        val totalHours = 14
        val height = hourHeight * totalHours
        val hours = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
        (0 until totalHours).forEach { offset ->
            hours.addView(label("${String.format(Locale.US, "%02d", firstHour + offset)}:00", 10f, color(R.color.muted), Typeface.BOLD).apply {
                gravity = Gravity.TOP or Gravity.END; typeface = Typeface.MONOSPACE; setPadding(0, 0, dp(8), 0)
            }, LinearLayout.LayoutParams(dp(47), hourHeight))
        }
        addView(hours, LinearLayout.LayoutParams(dp(47), height))
        val bodyWidth = resources.displayMetrics.widthPixels - dp(87)
        val body = FrameLayout(this@MainActivity).apply { background = rounded(color(R.color.surface), color(R.color.surface_edge), 16) }
        (0 until totalHours).forEach { offset ->
            body.addView(View(this@MainActivity).apply { setBackgroundColor(color(R.color.divider)); alpha = .75f }, FrameLayout.LayoutParams(MATCH, dp(1)).apply { topMargin = offset * hourHeight })
        }
        layoutTimed(items).forEach { timed ->
            val minuteTop = (timed.start - firstHour * 60).coerceAtLeast(0)
            val eventHeight = max(dp(44), ((timed.end - timed.start) / 60f * hourHeight).roundToInt())
            val columnWidth = bodyWidth / timed.columns
            body.addView(timelineEvent(timed.lesson), FrameLayout.LayoutParams(columnWidth - dp(5), eventHeight).apply {
                leftMargin = timed.column * columnWidth + dp(3)
                topMargin = (minuteTop / 60f * hourHeight).roundToInt() + dp(2)
            })
        }
        addView(body, LinearLayout.LayoutParams(bodyWidth, height))
    }

    private fun timelineEvent(lesson: Lesson) = TextView(this).apply {
        val fri = lesson.source == "FRI"
        text = "${lesson.start}\n${lesson.title}\n${lesson.room}"
        setTextColor(color(R.color.ink)); textSize = 11f; setTypeface(Typeface.create("sans-serif", Typeface.BOLD)); maxLines = 4
        setLineSpacing(0f, 1.05f); setPadding(dp(7), dp(6), dp(5), dp(5))
        background = rounded(color(if (fri) R.color.fri_fill else R.color.fmf_fill), color(if (fri) R.color.fri_edge else R.color.fmf_edge), 10)
        isClickable = true; isFocusable = true; foreground = selectableForeground()
        setOnClickListener { showLesson(lesson) }
    }

    private fun weekBoard(items: List<Lesson>) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        setPadding(0, dp(18), 0, 0)
        val cellWidth = ((resources.displayMetrics.widthPixels - dp(40) - dp(16)) / 5).coerceAtLeast(dp(58))
        (0..4).forEach { index ->
            val day = week.plusDays(index.toLong())
            val column = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(4), dp(8), dp(4), dp(5))
                background = rounded(color(R.color.surface), color(R.color.surface_edge), 12)
                addView(label(day.format(DateTimeFormatter.ofPattern("EEE", slovene)).replaceFirstChar { it.titlecase(slovene) }, 10f, color(R.color.muted), Typeface.BOLD).apply { gravity = Gravity.CENTER; letterSpacing = .03f }, LinearLayout.LayoutParams(MATCH, WRAP))
                addView(label(day.dayOfMonth.toString(), 15f, color(R.color.ink), Typeface.BOLD).apply { gravity = Gravity.CENTER; setPadding(0, dp(2), 0, dp(8)) }, LinearLayout.LayoutParams(MATCH, WRAP))
                val daily = items.filter { it.date == day.toString() }
                if (daily.isEmpty()) addView(label("—", 13f, color(R.color.muted), Typeface.NORMAL).apply { gravity = Gravity.CENTER; setPadding(0, dp(10), 0, dp(8)) }) else daily.forEach { addView(weekEvent(it)) }
            }
            addView(column, LinearLayout.LayoutParams(cellWidth, WRAP).apply { if (index != 4) rightMargin = dp(4) })
        }
    }

    private fun weekEvent(lesson: Lesson) = TextView(this).apply {
        val fri = lesson.source == "FRI"
        text = "${lesson.start}\n${lesson.title}"
        setTextColor(color(R.color.ink)); textSize = 9f; setTypeface(Typeface.create("sans-serif", Typeface.BOLD)); maxLines = 4
        setLineSpacing(0f, 1.02f); setPadding(dp(5), dp(5), dp(4), dp(6))
        background = rounded(color(if (fri) R.color.fri_fill else R.color.fmf_fill), color(if (fri) R.color.fri_edge else R.color.fmf_edge), 8)
        isClickable = true; isFocusable = true; foreground = selectableForeground()
        setOnClickListener { showLesson(lesson) }
        layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(4) }
    }

    private fun monthView(items: List<Lesson>) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(0, dp(18), 0, 0)
        val cellWidth = ((resources.displayMetrics.widthPixels - dp(40) - dp(16)) / 5).coerceAtLeast(dp(58))
        addView(GridLayout(this@MainActivity).apply {
            columnCount = 5
            listOf("Pon", "Tor", "Sre", "Čet", "Pet").forEach { name -> addView(label(name, 10f, color(R.color.muted), Typeface.BOLD).apply { gravity = Gravity.CENTER; letterSpacing = .04f }, GridLayout.LayoutParams().apply { width = cellWidth; height = dp(28) }) }
        })
        val grid = GridLayout(this@MainActivity).apply { columnCount = 5 }
        monthDays(monthAnchor).forEach { day ->
            val inMonth = day.month == monthAnchor.month
            val daily = items.filter { it.date == day.toString() }
            val cell = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(5), dp(5), dp(5), dp(4))
                background = rounded(color(if (inMonth) R.color.surface else R.color.empty_fill), color(R.color.surface_edge), 10)
                alpha = if (inMonth) 1f else .42f
                isClickable = true; isFocusable = true; foreground = selectableForeground()
                setOnClickListener { openDay(day) }
                addView(label(day.dayOfMonth.toString(), 11f, if (day == LocalDate.now()) color(R.color.today_text) else color(R.color.muted), Typeface.BOLD))
                daily.take(2).forEach { addView(monthEvent(it)) }
                if (daily.size > 2) addView(label("+${daily.size - 2}", 9f, color(R.color.muted), Typeface.BOLD).apply { setPadding(dp(3), dp(3), 0, 0) })
            }
            grid.addView(cell, GridLayout.LayoutParams().apply { width = cellWidth; height = dp(104); setMargins(0, 0, dp(4), dp(4)) })
        }
        addView(grid)
    }

    private fun monthEvent(lesson: Lesson) = TextView(this).apply {
        val fri = lesson.source == "FRI"
        text = "${lesson.start} ${lesson.title}"
        setTextColor(color(if (fri) R.color.fri_text else R.color.fmf_text)); textSize = 8f; setTypeface(Typeface.create("sans-serif", Typeface.BOLD)); maxLines = 1
        setPadding(dp(3), dp(3), dp(2), dp(3)); background = rounded(color(if (fri) R.color.fri_fill else R.color.fmf_fill), color(if (fri) R.color.fri_fill else R.color.fmf_fill), 5)
        layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(3) }
        isClickable = true; setOnClickListener { showLesson(lesson) }
    }

    private fun openDay(day: LocalDate) { week = day.with(DayOfWeek.MONDAY); mode = ViewMode.AGENDA; prefs.edit().putString("view", mode.name).apply(); updateViewSwitcher(); loadWeek() }

    private fun layoutTimed(items: List<Lesson>): List<TimedLesson> {
        val sorted = items.sortedBy { minutes(it.start) }
        val groups = mutableListOf<MutableList<Lesson>>()
        var group = mutableListOf<Lesson>(); var groupEnd = -1
        sorted.forEach { lesson ->
            val start = minutes(lesson.start)
            if (group.isNotEmpty() && start >= groupEnd) { groups += group; group = mutableListOf(); groupEnd = -1 }
            group += lesson; groupEnd = max(groupEnd, minutes(lesson.end))
        }
        if (group.isNotEmpty()) groups += group
        return groups.flatMap { overlap ->
            val columns = mutableListOf<Int>()
            val laidOut = overlap.map { lesson ->
                val start = minutes(lesson.start); val end = minutes(lesson.end)
                var column = columns.indexOfFirst { it <= start }
                if (column < 0) { column = columns.size; columns += end } else columns[column] = end
                Triple(lesson, start, Pair(end, column))
            }
            laidOut.map { (lesson, start, endColumn) -> TimedLesson(lesson, start, endColumn.first, endColumn.second, columns.size) }
        }
    }

    private fun monthDays(anchor: LocalDate): List<LocalDate> {
        val month = YearMonth.from(anchor)
        val first = month.atDay(1)
        val start = first.minusDays((first.dayOfWeek.value - 1).toLong())
        val last = month.atEndOfMonth()
        val end = last.plusDays((5 - last.dayOfWeek.value).coerceAtLeast(0).toLong())
        return generateSequence(start) { if (it >= end) null else it.plusDays(1) }.filter { it.dayOfWeek.value <= 5 }.toList()
    }

    private fun lessonCard(lesson: Lesson, order: Int): View {
        val fri = lesson.source == "FRI"; val fill = color(if (fri) R.color.fri_fill else R.color.fmf_fill); val edge = color(if (fri) R.color.fri_edge else R.color.fmf_edge); val accent = color(if (fri) R.color.fri_text else R.color.fmf_text)
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.TOP; setPadding(dp(15), dp(15), dp(14), dp(14)); background = rounded(fill, edge, 18); isClickable = true; isFocusable = true; foreground = selectableForeground(); contentDescription = "${lesson.title}, ${lesson.start} do ${lesson.end}"; setOnClickListener { showLesson(lesson) }
            addView(LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL; addView(label(lesson.start, 14f, accent, Typeface.BOLD).apply { typeface = Typeface.MONOSPACE }); addView(label(lesson.end, 12f, color(R.color.muted), Typeface.NORMAL).apply { typeface = Typeface.MONOSPACE; setPadding(0, dp(3), 0, 0) }) }, LinearLayout.LayoutParams(dp(67), WRAP))
            addView(LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL; addView(label(lesson.title, 17f, color(R.color.ink), Typeface.BOLD).apply { setLineSpacing(0f, 1.04f) }); addView(label(listOfNotNull(lesson.type.takeIf { it.isNotBlank() }, lesson.room.takeIf { it.isNotBlank() } ?: "Prostor ni znan").joinToString(" · "), 13f, color(R.color.muted), Typeface.NORMAL).apply { setPadding(0, dp(5), 0, 0) }); addView(tag(lesson.source, if (fri) color(R.color.fri_tag) else color(R.color.fmf_tag), accent).apply { setPadding(dp(8), dp(4), dp(8), dp(4)); layoutParams = LinearLayout.LayoutParams(WRAP, WRAP).apply { topMargin = dp(11) } }) }, LinearLayout.LayoutParams(0, WRAP).apply { weight = 1f })
            layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(8) }; alpha = 0f; translationY = dp(10).toFloat(); post { animate().alpha(1f).translationY(0f).setStartDelay((order.coerceAtMost(8) * 28L)).setDuration(230L).setInterpolator(android.view.animation.DecelerateInterpolator()).start() }
        }
    }

    private fun showLesson(lesson: Lesson) {
        val fri = lesson.source == "FRI"; val fill = color(if (fri) R.color.fri_fill else R.color.fmf_fill); val edge = color(if (fri) R.color.fri_edge else R.color.fmf_edge); val accent = color(if (fri) R.color.fri_text else R.color.fmf_text)
        BottomSheetDialog(this).also { dialog ->
            val sheet = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(12), dp(24), dp(32)); setBackgroundColor(color(R.color.canvas)); addView(View(this@MainActivity).apply { background = rounded(color(R.color.sheet_handle), color(R.color.sheet_handle), 3) }, LinearLayout.LayoutParams(dp(36), dp(4)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(24) }); addView(tag(lesson.source, if (fri) color(R.color.fri_tag) else color(R.color.fmf_tag), accent).apply { layoutParams = LinearLayout.LayoutParams(WRAP, WRAP).apply { bottomMargin = dp(12) } }); addView(label(lesson.title, 26f, color(R.color.ink), Typeface.BOLD).apply { setLineSpacing(0f, 1.04f) }); addView(label("${lesson.start}–${lesson.end} · ${lesson.type}", 15f, color(R.color.muted), Typeface.NORMAL).apply { setPadding(0, dp(8), 0, dp(20)) }); addView(detailRow("PROSTOR", lesson.room.ifBlank { "Ni podatka" }, fill, edge)); addView(detailRow("IZVAJALEC", lesson.teacher.ifBlank { "Ni podatka" }, fill, edge).apply { layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(8) } }) }
            dialog.setContentView(sheet); dialog.show()
        }
    }

    private fun detailRow(name: String, value: String, fill: Int, edge: Int) = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(15), dp(13), dp(15), dp(14)); background = rounded(fill, edge, 14); addView(label(name, 10f, color(R.color.muted), Typeface.BOLD).apply { letterSpacing = 0.1f }); addView(label(value, 16f, color(R.color.ink), Typeface.BOLD).apply { setPadding(0, dp(5), 0, 0) }) }

    private fun showSettings() {
        val dialog = BottomSheetDialog(this); val view = layoutInflater.inflate(R.layout.sheet_settings, null); val years = view.findViewById<Spinner>(R.id.settings_year); val personalNumber = view.findViewById<EditText>(R.id.settings_student)
        years.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, arrayOf("1. letnik", "2. letnik", "3. letnik")); years.setSelection(year.toIntOrNull()?.minus(1)?.coerceIn(0, 2) ?: 0); personalNumber.setText(student)
        view.findViewById<TextView>(R.id.settings_save).setOnClickListener { prefs.edit().putString("year", (years.selectedItemPosition + 1).toString()).putString("student", personalNumber.text.toString().filter(Char::isDigit)).apply(); dialog.dismiss(); if (mode == ViewMode.MONTH) loadMonth() else loadWeek() }
        dialog.setContentView(view); dialog.show()
    }

    private fun minutes(time: String): Int { val pieces = time.split(':').mapNotNull { it.toIntOrNull() }; return pieces.getOrElse(0) { 0 } * 60 + pieces.getOrElse(1) { 0 } }
    private fun label(text: String, size: Float, textColor: Int, style: Int) = TextView(this).apply { this.text = text; setTextColor(textColor); textSize = size; setTypeface(Typeface.create("sans-serif", style)) }
    private fun tag(text: String, fill: Int, textColor: Int) = label(text, 10f, textColor, Typeface.BOLD).apply { gravity = Gravity.CENTER; letterSpacing = 0.08f; background = rounded(fill, fill, 8) }
    private fun rounded(fill: Int, stroke: Int, radius: Int) = GradientDrawable().apply { shape = GradientDrawable.RECTANGLE; cornerRadius = dp(radius).toFloat(); setColor(fill); setStroke(dp(1), stroke) }
    private fun selectableForeground(): android.graphics.drawable.Drawable? { val value = TypedValue(); theme.resolveAttribute(android.R.attr.selectableItemBackground, value, true); return ContextCompat.getDrawable(this, value.resourceId) }
    private fun color(id: Int) = ContextCompat.getColor(this, id)
    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()

    private fun newer(remote: String, local: String): Boolean { val a = remote.split('.').map { it.toIntOrNull() ?: 0 }; val b = local.split('.').map { it.toIntOrNull() ?: 0 }; for (index in 0 until maxOf(a.size, b.size)) { val x = a.getOrElse(index) { 0 }; val y = b.getOrElse(index) { 0 }; if (x != y) return x > y }; return false }
    private fun checkRelease() = executor.execute { val update = runCatching { val release = org.json.JSONObject(URL("${BuildConfig.WEB_APP_URL.trimEnd('/')}/api/release").readText()); ReleaseInfo(release.optString("androidVersion"), releasePage(release.optString("androidReleaseUrl"))) }.getOrNull() ?: return@execute; if (newer(update.version, BuildConfig.VERSION_NAME) && update.releaseUrl.startsWith("https://")) runOnUiThread { val separator = if (update.releaseUrl.contains("?")) "&" else "?"; val destination = "${update.releaseUrl}${separator}installed=${Uri.encode(BuildConfig.VERSION_NAME)}"; androidx.appcompat.app.AlertDialog.Builder(this).setTitle("Na voljo je posodobitev IŠRM").setMessage("Različica ${update.version} je pripravljena.").setNegativeButton("Kasneje", null).setPositiveButton("Odpri posodobitev") { _, _ -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(destination))) }.show() } }
    private fun releasePage(configured: String): String { val base = BuildConfig.WEB_APP_URL.trimEnd('/'); return when { configured.startsWith("https://") -> configured; configured.startsWith("/") -> "$base$configured"; else -> "$base/android" } }
    override fun onDestroy() { executor.shutdownNow(); super.onDestroy() }
    private companion object { const val MATCH = LinearLayout.LayoutParams.MATCH_PARENT; const val WRAP = LinearLayout.LayoutParams.WRAP_CONTENT }
}
