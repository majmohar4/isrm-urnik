package eu.majmohar.isrm

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.provider.CalendarContract
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.animation.AnimatorSet
import android.animation.ArgbEvaluator
import android.animation.ObjectAnimator
import android.animation.StateListAnimator
import android.animation.ValueAnimator
import android.view.HapticFeedbackConstants
import android.view.animation.DecelerateInterpolator
import android.view.animation.PathInterpolator
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.widget.NestedScrollView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import org.json.JSONObject
import java.net.URL
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {
    private enum class ViewMode(val title: String) { AGENDA("Seznam"), TIMELINE("Časovni"), WEEK("Teden"), MONTH("Mesec") }
    private data class TimedLesson(val lesson: Lesson, val start: Int, val end: Int, val column: Int, val columns: Int)

    // Network work is serialised so a slow week cannot overwrite a newer one; preloading gets its own thread so it never delays navigation.
    private val executor = Executors.newSingleThreadExecutor()
    private val background = Executors.newSingleThreadExecutor()
    private val slovene = Locale("sl", "SI")
    private val shortDate = DateTimeFormatter.ofPattern("d. MMM", slovene)
    private val rangeFormat = DateTimeFormatter.ofPattern("d. M.", slovene)
    private val longDate = DateTimeFormatter.ofPattern("EEEE, d. MMMM", slovene)
    private val monthFormat = DateTimeFormatter.ofPattern("LLLL yyyy", slovene)
    private val weekdayShort = DateTimeFormatter.ofPattern("EEE", slovene)
    private val prefs by lazy { getSharedPreferences("native-settings", MODE_PRIVATE) }
    private val year get() = prefs.getString("year", "1") ?: "1"
    private val student get() = prefs.getString("student", "") ?: ""
    private lateinit var repo: TimetableRepository
    private lateinit var scroll: NestedScrollView
    private lateinit var refresher: SwipeRefreshLayout
    private lateinit var content: FrameLayout
    private lateinit var loading: View
    private lateinit var subtitle: TextView
    private lateinit var fetched: TextView
    private lateinit var notice: TextView
    private lateinit var sources: TextView
    private lateinit var viewModes: LinearLayout
    private lateinit var addEvent: View
    private var bottomInset = 0
    private var touchSlop = 0
    private var downX = 0f
    private var downY = 0f
    private var tracking = false
    private var dragging = false
    // Časovni keeps its day buttons still while only the day below them changes, so both parts are kept to animate separately.
    private var timelineChips: LinearLayout? = null
    private var timelineBody: FrameLayout? = null
    private var week = thisMonday()
    private var monthAnchor = LocalDate.now().withDayOfMonth(1)
    private var timelineDayIndex = todayIndex()
    private var mode = ViewMode.AGENDA
    private var weekData = Schedule(emptyList())
    private var monthEvents: List<Lesson> = emptyList()
    private var loadToken = 0
    private var error = ""
    private var refreshing = false
    private var adminUnlocked = false
    // Saved admin access only allows editing; this switch actually turns it on, and it starts off on every fresh launch
    // so the timetable cannot be changed by an accidental tap.
    private var editMode = false
    private val canEdit get() = adminUnlocked && editMode
    private var preloaded = false

    override fun onCreate(savedInstanceState: Bundle?) {
        // Applied before super so the first frame already uses the chosen theme instead of flashing and recreating.
        AppCompatDelegate.setDefaultNightMode(nightModeFor(prefs.getString("theme", "system") ?: "system"))
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)
        repo = TimetableRepository(this)
        // Preferences need an attached Context, so the saved view is read here rather than in a field initializer.
        mode = ViewMode.entries.firstOrNull { it.name == prefs.getString("view", ViewMode.AGENDA.name) } ?: ViewMode.AGENDA
        savedInstanceState?.let { state ->
            state.getString("week")?.let { week = LocalDate.parse(it) }
            state.getString("month")?.let { monthAnchor = LocalDate.parse(it) }
            timelineDayIndex = state.getInt("day", timelineDayIndex)
            // (admin access is restored from the saved key below; only the edit switch survives a recreate)
            editMode = state.getBoolean("edit", false)
        }
        scroll = findViewById(R.id.scroll)
        refresher = findViewById(R.id.refresher)
        content = findViewById(R.id.content)
        loading = findViewById(R.id.loading)
        subtitle = findViewById(R.id.week_subtitle)
        fetched = findViewById(R.id.fetched)
        notice = findViewById(R.id.notice)
        sources = findViewById(R.id.sources)
        viewModes = findViewById(R.id.view_modes)
        addEvent = findViewById(R.id.add_event)
        applyInsets()
        // Let swiped pages draw through the side margins instead of being cut off at the content edge.
        content.clipChildren = false; (content.parent as ViewGroup).clipChildren = false
        buildViewSwitcher()
        attachSwipeNavigation()

        refresher.setColorSchemeColors(color(R.color.accent))
        refresher.setProgressBackgroundColorSchemeColor(color(R.color.surface))
        refresher.setOnRefreshListener { reload(true) }
        findViewById<ImageButton>(R.id.previous).setOnClickListener { movePeriod(false) }
        findViewById<ImageButton>(R.id.next).setOnClickListener { movePeriod(true) }
        findViewById<View>(R.id.period).setOnClickListener { goToday() }
        findViewById<TextView>(R.id.today).setOnClickListener { goToday() }
        findViewById<ImageButton>(R.id.settings).setOnClickListener { showSettings() }
        addEvent.setOnClickListener { showAdminMenu() }
        adminUnlocked = adminToken().isNotBlank()
        updateAdmin()
        migrateAdminPassword()
        if (android.os.Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { finish() }
        reload(false)
        if (!releaseChecked) { releaseChecked = true; checkRelease() }
        // First start of a new version (after an in-app update or any install): a short confirmation.
        if (prefs.getString("last-version", null).let { it != null && it != BuildConfig.VERSION_NAME }) toast("IŠRM je posodobljen na ${BuildConfig.VERSION_NAME}.")
        prefs.edit().putString("last-version", BuildConfig.VERSION_NAME).apply()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString("week", week.toString()); outState.putString("month", monthAnchor.toString())
        outState.putInt("day", timelineDayIndex); outState.putBoolean("edit", editMode)
    }

    // Re-render on return so "now" highlighting and the today marker are not stale after the app sat in the background.
    // While the app is open it asks the server every 20 s whether anything admin-made changed (a few bytes); only then
    // does it reload, skipping the local 10-minute cache, so new events, cancellations and messages appear within seconds.
    private val livePoll = android.os.Handler(android.os.Looper.getMainLooper())
    private val liveTick = object : Runnable {
        override fun run() {
            background.execute {
                val revision = repo.revision() ?: return@execute
                val seen = prefs.getLong("revision", 0L)
                prefs.edit().putLong("revision", revision).apply()
                if (seen != 0L && seen != revision) runOnUiThread { if (!isDestroyed && !dragging) { if (mode == ViewMode.MONTH) loadMonth(false, bypassCache = true) else loadWeek(false, bypassCache = true) } }
            }
            livePoll.postDelayed(this, LIVE_POLL_MS)
        }
    }

    override fun onPause() { super.onPause(); livePoll.removeCallbacks(liveTick) }

    override fun onResume() {
        super.onResume()
        livePoll.removeCallbacks(liveTick); livePoll.post(liveTick)
        if (content.childCount > 0) render(animate = false)
        // Back from the "install unknown apps" setting: continue the update if it was allowed.
        pendingUpdate?.let { resume -> if (android.os.Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls()) { pendingUpdate = null; resume() } }
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean = handleSwipe(event) || super.dispatchTouchEvent(event)

    // targetSdk 35 forces edge-to-edge on Android 15+, so the system bars are padded in by hand.
    private fun applyInsets() {
        val column = findViewById<View>(R.id.column)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root)) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            bottomInset = bars.bottom
            column.setPadding(dp(20) + bars.left, dp(12) + bars.top, dp(20) + bars.right, columnBottom())
            (addEvent.layoutParams as FrameLayout.LayoutParams).setMargins(0, 0, dp(20) + bars.right, dp(20) + bars.bottom)
            addEvent.requestLayout()
            refresher.setProgressViewOffset(false, bars.top, bars.top + dp(72))
            insets
        }
    }

    private fun buildViewSwitcher() {
        // The selected tab is marked by one pill that slides between tabs, so the tabs themselves stay transparent when selected.
        val scroller = viewModes.parent as ViewGroup
        scroller.removeView(viewModes)
        scroller.addView(withPill(viewModes, dp(38), 13, WRAP))
        viewModes.removeAllViews()
        ViewMode.entries.forEach { candidate ->
            viewModes.addView(chip(candidate.title, false) { selectMode(candidate) }.apply { tag = candidate; setPadding(dp(17), 0, dp(17), 0) }, LinearLayout.LayoutParams(WRAP, MATCH).apply { rightMargin = dp(7) })
        }
        updateViewSwitcher(animate = false)
    }

    private fun updateViewSwitcher(animate: Boolean = true) {
        repeat(viewModes.childCount) { index ->
            val view = viewModes.getChildAt(index) as TextView
            if (view.tag == mode) paintChip(view, Color.TRANSPARENT, Color.TRANSPARENT, color(R.color.on_accent), 13, animate)
            else styleChip(view, false, animate)
        }
        movePill(viewModes, viewModes.findViewWithTag(mode), animate)
    }

    /** Wraps a row of chips with one accent pill behind them; [movePill] slides it to the selected chip. */
    private fun withPill(row: LinearLayout, height: Int, radius: Int, rowWidth: Int) = FrameLayout(this).apply {
        val pill = View(this@MainActivity).apply { background = rounded(color(R.color.accent), color(R.color.accent), radius) }
        row.setTag(R.id.pill, pill)
        addView(pill, FrameLayout.LayoutParams(0, height))
        addView(row, FrameLayout.LayoutParams(rowWidth, height))
    }

    private fun movePill(row: ViewGroup, target: View?, animate: Boolean) {
        val pill = row.getTag(R.id.pill) as? View ?: return
        if (target == null) return
        // Before the first layout the chips have no size yet; place the pill once they do.
        if (target.width == 0) { target.post { if (target.width > 0) movePill(row, target, false) }; return }
        val params = pill.layoutParams
        if (!animate || params.width == 0) { params.width = target.width; pill.layoutParams = params; pill.translationX = target.left.toFloat(); return }
        val fromX = pill.translationX; val fromW = params.width
        ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 380L; interpolator = android.view.animation.OvershootInterpolator(0.9f)
            addUpdateListener { a ->
                val t = a.animatedValue as Float
                pill.translationX = fromX + (target.left - fromX) * t
                params.width = (fromW + (target.width - fromW) * t).roundToInt().coerceAtLeast(1); pill.layoutParams = params
            }
        }.start()
    }

    private fun selectMode(next: ViewMode) {
        if (mode == next) return
        val wasMonth = mode == ViewMode.MONTH
        mode = next
        prefs.edit().putString("view", next.name).apply()
        updateViewSwitcher()
        when {
            next == ViewMode.MONTH -> { monthAnchor = monthFor(week); loadMonth(false, fade = true) }
            wasMonth -> {
                // Continue in the month that was being looked at: today's week if it is this month, otherwise its first week.
                val current = monthAnchor.withDayOfMonth(1) == LocalDate.now().withDayOfMonth(1)
                week = if (current) thisMonday() else monthAnchor.withDayOfMonth(1).with(java.time.temporal.TemporalAdjusters.nextOrSame(DayOfWeek.MONDAY))
                timelineDayIndex = if (current) todayIndex() else 0
                loadWeek(false, fade = true)
            }
            else -> { updateHeader(); render(animate = true, fadeThrough = true) }
        }
    }

    private fun attachSwipeNavigation() { touchSlop = android.view.ViewConfiguration.get(this).scaledTouchSlop }

    /** Everything that identifies one page of the timetable, so a neighbouring page can be built before it is shown. */
    private data class Page(val week: LocalDate, val day: Int, val month: LocalDate, val data: Schedule, val monthItems: List<Lesson>, val dayLevel: Boolean)

    private var velocity: android.view.VelocityTracker? = null
    private var pagerHost: ViewGroup? = null
    private var pagerCurrent: View? = null
    private var pagerNext: View? = null
    private var pagerForward: Boolean? = null
    private var pagerPage: Page? = null
    private var pagerChips: LinearLayout? = null
    private var pagerBody: FrameLayout? = null
    private val pagerSprings = mutableListOf<SpringAnimation>()

    /**
     * Horizontal drags turn the page like a pager: the neighbouring week (or day in Časovni) is built from the cache
     * and sits beside the current one, both following the finger 1:1. A short flick is enough; release finishes with a
     * spring that starts at the finger's velocity. Vertical drags stay with scrolling and pull-to-refresh, and once a
     * drag is claimed the children get ACTION_CANCEL so a lesson under the finger does not also open.
     */
    private fun handleSwipe(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                settlePager()
                val area = Rect()
                tracking = content.getGlobalVisibleRect(area) && area.contains(event.rawX.toInt(), event.rawY.toInt()) && content.childCount > 0
                dragging = false; downX = event.rawX; downY = event.rawY
                velocity?.recycle(); velocity = android.view.VelocityTracker.obtain()
                velocity?.addMovement(event)
            }
            MotionEvent.ACTION_MOVE -> if (tracking) {
                velocity?.addMovement(event)
                val dx = event.rawX - downX; val dy = event.rawY - downY
                if (!dragging) {
                    if (abs(dy) > touchSlop && abs(dy) >= abs(dx)) tracking = false
                    else if (abs(dx) > touchSlop * 1.5f && abs(dx) > abs(dy) * 1.3f) {
                        dragging = true; refresher.isEnabled = false
                        val cancel = MotionEvent.obtain(event).apply { action = MotionEvent.ACTION_CANCEL }
                        super.dispatchTouchEvent(cancel); cancel.recycle()
                    }
                }
                if (dragging) { dragPager(dx); return true }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                val wasDragging = dragging
                tracking = false; dragging = false; refresher.isEnabled = true
                if (wasDragging) {
                    velocity?.addMovement(event); velocity?.computeCurrentVelocity(1000)
                    releasePager(event.rawX - downX, velocity?.xVelocity ?: 0f, event.actionMasked == MotionEvent.ACTION_UP)
                    return true
                }
            }
        }
        return false
    }

    private fun dragPager(dx: Float) {
        val forward = dx < 0
        if (pagerForward != forward) {
            pagerNext?.let { pagerHost?.removeView(it) }
            pagerCurrent?.apply { translationX = 0f; alpha = 1f }
            val page = neighbour(forward)
            val host: ViewGroup = if (page.dayLevel) timelineBody ?: content else content
            pagerHost = host; pagerPage = page; pagerForward = forward
            pagerCurrent = host.getChildAt(host.childCount - 1)
            pagerNext = buildPage(page).also { host.addView(it, FrameLayout.LayoutParams(MATCH, WRAP)) }
            (if (host === content) timelineBody else content)?.translationX = 0f
        }
        val width = pageStride()
        pagerCurrent?.translationX = dx
        pagerNext?.translationX = dx + (if (forward) width else -width)
        // The incoming page brightens as it arrives, the outgoing one dims a touch — depth without a heavy effect.
        val progress = (abs(dx) / width).coerceIn(0f, 1f)
        pagerCurrent?.alpha = 1f - progress * .35f
        pagerNext?.alpha = .6f + progress * .4f
    }

    private fun releasePager(dx: Float, vx: Float, lifted: Boolean) {
        val current = pagerCurrent; val next = pagerNext; val host = pagerHost; val forward = pagerForward ?: return
        if (current == null || next == null || host == null) return
        val width = pageStride()
        val flung = if (forward) vx < -700f else vx > 700f
        val against = if (forward) vx > 700f else vx < -700f
        val commit = lifted && !against && (flung || abs(dx) > width * 0.33f)
        val sign = if (forward) -1f else 1f
        pagerSprings.clear()
        if (commit) {
            tick()
            pagerSprings += pagerSpring(current, sign * width, vx)
            pagerSprings += pagerSpring(next, 0f, vx) { finishPage(host, current, next) }
            current.animate().alpha(.4f).setDuration(220L).start(); next.animate().alpha(1f).setDuration(180L).start()
        } else {
            pagerSprings += pagerSpring(current, 0f, vx)
            pagerSprings += pagerSpring(next, -sign * width, vx) { host.removeView(next) }
            current.animate().alpha(1f).setDuration(180L).start()
            pagerNext = null; pagerForward = null
        }
    }

    // Pages sit one screen-margin apart, so the next one starts just off-screen and a gap shows between them mid-swipe.
    private fun pageStride() = ((pagerHost?.width ?: content.width) + dp(24)).toFloat()

    private fun pagerSpring(view: View, target: Float, startVelocity: Float, end: (() -> Unit)? = null) =
        SpringAnimation(view, DynamicAnimation.TRANSLATION_X, target).apply {
            spring.stiffness = 520f; spring.dampingRatio = 0.92f
            setStartVelocity(startVelocity)
            end?.let { done -> addEndListener { _, _, _, _ -> done() } }
            start()
        }

    // A new touch during a running spring jumps it to its end, so the next drag always starts from a settled page.
    private fun settlePager() {
        pagerSprings.toList().forEach { if (it.isRunning) it.skipToEnd() }
        pagerSprings.clear()
    }

    private fun finishPage(host: ViewGroup, old: View, next: View) {
        host.removeView(old)
        next.translationX = 0f; next.alpha = 1f
        val page = pagerPage ?: return
        val forward = pagerForward ?: true
        pagerNext = null; pagerForward = null; pagerCurrent = null
        lastDirection = forward
        week = page.week; timelineDayIndex = page.day; monthAnchor = page.month
        if (page.dayLevel) {
            val days = daysOf(week, weekData.events)
            timelineChips?.let { chips -> repeat(chips.childCount) { i -> styleDayChip(chips.getChildAt(i) as TextView, days[i], i == page.day, animate = true) }; movePill(chips, chips.getChildAt(page.day), true) }
            return
        }
        if (mode == ViewMode.TIMELINE) { timelineChips = pagerChips; timelineBody = pagerBody }
        // The page on screen was built from the cache; fetch fresh data without animating it in a second time.
        if (mode == ViewMode.MONTH) loadMonth(false, null, quiet = true) else loadWeek(false, null, quiet = true)
    }

    private fun neighbour(forward: Boolean): Page {
        val step = if (forward) 1L else -1L
        return when {
            mode == ViewMode.MONTH -> monthAnchor.plusMonths(step).let { Page(week, timelineDayIndex, it, weekData, repo.monthCached(it, year, student), false) }
            mode == ViewMode.TIMELINE && timelineDayIndex + step in 0..daysOf(week, weekData.events).lastIndex -> Page(week, (timelineDayIndex + step).toInt(), monthAnchor, weekData, monthEvents, true)
            else -> week.plusWeeks(step).let { next -> repo.cachedWeek(next, year, student).let { data -> Page(next, if (forward) 0 else daysOf(next, data.events).lastIndex, monthAnchor, data, monthEvents, false) } }
        }
    }

    /** Builds [page] with the same builders as the live screen by briefly swapping the state they read. */
    private fun buildPage(page: Page): View {
        val saved = Page(week, timelineDayIndex, monthAnchor, weekData, monthEvents, false)
        val savedChips = timelineChips; val savedBody = timelineBody
        week = page.week; timelineDayIndex = page.day; monthAnchor = page.month; weekData = page.data; monthEvents = page.monthItems
        val view = if (page.dayLevel) timelineDay(page.data.events) else when (mode) {
            ViewMode.AGENDA -> agendaView(page.data.events, false)
            ViewMode.TIMELINE -> timelineView(page.data.events)
            ViewMode.WEEK -> weekView(page.data.events)
            ViewMode.MONTH -> monthView(page.monthItems)
        }
        pagerChips = timelineChips; pagerBody = timelineBody
        week = saved.week; timelineDayIndex = saved.day; monthAnchor = saved.month; weekData = saved.data; monthEvents = saved.monthItems
        timelineChips = savedChips; timelineBody = savedBody
        return view
    }

    private var lastDirection: Boolean? = null

    private fun moveTimelineDay(forward: Boolean) {
        when {
            forward && timelineDayIndex < daysOf(week, weekData.events).lastIndex -> showTimelineDay(timelineDayIndex + 1)
            !forward && timelineDayIndex > 0 -> showTimelineDay(timelineDayIndex - 1)
            else -> { tick(); week = if (forward) week.plusWeeks(1) else week.minusWeeks(1); timelineDayIndex = if (forward) 0 else 4; loadWeek(false, forward) }
        }
    }

    private fun movePeriod(forward: Boolean) {
        tick()
        if (mode == ViewMode.MONTH) {
            monthAnchor = if (forward) monthAnchor.plusMonths(1) else monthAnchor.minusMonths(1)
            loadMonth(false, forward)
        } else {
            week = if (forward) week.plusWeeks(1) else week.minusWeeks(1)
            loadWeek(false, forward)
        }
    }

    private fun goToday() {
        val forward = if (mode == ViewMode.MONTH) monthAnchor < LocalDate.now().withDayOfMonth(1) else week < thisMonday()
        week = thisMonday(); monthAnchor = LocalDate.now().withDayOfMonth(1); timelineDayIndex = todayIndex()
        reload(false, forward)
    }

    private fun reload(manual: Boolean, forward: Boolean? = null) = if (mode == ViewMode.MONTH) loadMonth(manual, forward) else loadWeek(manual, forward)

    private fun loadWeek(manual: Boolean, forward: Boolean? = null, quiet: Boolean = false, fade: Boolean = false, bypassCache: Boolean = false) {
        val token = ++loadToken; val w = week; val y = year; val s = student
        val cached = repo.cachedWeek(w, y, s)
        weekData = cached; error = ""; refreshing = true
        if (forward != null) lastDirection = forward
        updateHeader()
        // quiet: the page is already on screen (a finished swipe), so only the header and later the fresh data change.
        if (!quiet) render(skeleton = cached.events.isEmpty() && cached.fetchedAt.isBlank(), animate = forward != null || content.childCount == 0, forward = forward ?: true, fadeThrough = fade)
        if (!manual && !bypassCache && repo.weekFresh(w, y, s)) {
            refreshing = false; refresher.isRefreshing = false; updateHeader()
            background.execute { listOf(-1L, 1L).forEach { step -> val neighbour = w.plusWeeks(step); if (!repo.weekFresh(neighbour, y, s)) runCatching { repo.refresh(neighbour, y, s) } } }
            return
        }
        executor.execute {
            val attempt = runCatching { repo.loadWeek(w, y, s, manual) }
            runOnUiThread {
                if (token != loadToken || isDestroyed) return@runOnUiThread
                refreshing = false; refresher.isRefreshing = false
                attempt.onSuccess { weekData = it; error = it.error }.onFailure { error = friendly(it) }
                updateHeader(); render(animate = false)
            }
            if (attempt.isSuccess && !preloaded) { preloaded = true; background.execute { repo.preload(y, s) } }
            // The weeks on either side are fetched quietly so a swipe already shows them instead of an empty page.
            if (attempt.isSuccess) background.execute { listOf(-1L, 1L).forEach { step -> val neighbour = w.plusWeeks(step); if (!repo.weekFresh(neighbour, y, s)) runCatching { repo.refresh(neighbour, y, s) } } }
        }
    }

    private fun loadMonth(manual: Boolean, forward: Boolean? = null, quiet: Boolean = false, fade: Boolean = false, bypassCache: Boolean = false) {
        val token = ++loadToken; val m = monthAnchor; val y = year; val s = student
        val cached = repo.monthCached(m, y, s)
        monthEvents = cached; error = ""; refreshing = true
        if (forward != null) lastDirection = forward
        updateHeader()
        if (!quiet) render(skeleton = cached.isEmpty(), animate = forward != null || content.childCount == 0, forward = forward ?: true, fadeThrough = fade)
        if (!manual && !bypassCache && repo.monthFresh(m, y, s)) { refreshing = false; refresher.isRefreshing = false; updateHeader(); return }
        executor.execute {
            val attempt = runCatching { repo.refreshMonth(m, y, s) }
            runOnUiThread {
                if (token != loadToken || isDestroyed) return@runOnUiThread
                refreshing = false; refresher.isRefreshing = false
                attempt.onSuccess { monthEvents = it }.onFailure { error = friendly(it) }
                if (attempt.isSuccess) background.execute { listOf(-1L, 1L).forEach { step -> val neighbour = m.plusMonths(step); if (!repo.monthFresh(neighbour, y, s)) runCatching { repo.refreshMonth(neighbour, y, s) } } }
                updateHeader(); render(animate = false)
            }
        }
    }

    private fun friendly(failure: Throwable): String {
        if (failure is AdminRevokedException) {
            prefs.edit().remove("admin-token").apply()
            adminUnlocked = false; updateAdmin()
            return failure.message ?: ""
        }
        return (failure as? ApiException)?.message ?: "Povezava z urnikom ni uspela. Prikazan je shranjen urnik."
    }

    private fun updateHeader() {
        findViewById<TextView>(R.id.programme_label).apply {
            text = "IŠRM · $year. letnik${if (student.isNotBlank()) " · osebni" else ""}${if (canEdit) " · UREJANJE" else ""}"
            setTextColor(color(if (canEdit) R.color.warning else R.color.muted))
        }
        roll(subtitle, if (mode == ViewMode.MONTH) monthAnchor.format(monthFormat).replaceFirstChar { it.titlecase(slovene) } else "${week.format(rangeFormat)} – ${week.plusDays(4).format(rangeFormat)}", lastDirection)
        lastDirection = null
        val total = if (mode == ViewMode.MONTH) monthEvents.size else weekData.events.size
        val tally = "$total ${if (total == 1) "obveznost" else "obveznosti"}"
        fetched.text = when {
            refreshing -> "Osvežujem …"
            mode == ViewMode.MONTH -> tally
            else -> "Osveženo ${fetchedLabel(weekData.fetchedAt)} · $tally"
        }
        val current = if (mode == ViewMode.MONTH) monthAnchor.withDayOfMonth(1) == LocalDate.now().withDayOfMonth(1) else week == thisMonday()
        findViewById<TextView>(R.id.today).apply { alpha = if (current) .45f else 1f; isEnabled = !current }
        val down = weekData.sources.filterValues { !it }.keys
        val message = error.ifBlank { if (mode != ViewMode.MONTH && down.isNotEmpty()) "Pozor: ${down.joinToString()} trenutno ni dosegljiv. Prikazani so zadnji uspešno shranjeni podatki." else "" }
        renderAnnouncements()
        notice.visibility = if (message.isBlank()) View.GONE else View.VISIBLE
        notice.text = message
        notice.background = rounded(color(R.color.notice_fill), color(R.color.notice_fill), 14)
        sources.text = SpannableStringBuilder().apply {
            listOf("FRI", "FMF").forEach { source ->
                val ok = weekData.sources[source] ?: true
                val startDot = length; append("● "); setSpan(ForegroundColorSpan(color(if (ok) R.color.ok else R.color.warning)), startDot, startDot + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE); append("$source   ")
            }
            append("v${BuildConfig.VERSION_NAME} · ${buildDate()}")
        }
    }

    private fun fetchedLabel(value: String): String {
        val instant = runCatching { Instant.parse(value) }.getOrNull() ?: return "še ni osveženo"
        val local = instant.atZone(ZoneId.systemDefault())
        return if (local.toLocalDate() == LocalDate.now()) local.format(DateTimeFormatter.ofPattern("HH:mm")) else local.format(DateTimeFormatter.ofPattern("d. M. HH:mm"))
    }

    private fun render(skeleton: Boolean = false, animate: Boolean, forward: Boolean = true, fadeThrough: Boolean = false) {
        loading.visibility = if (skeleton) View.VISIBLE else View.GONE
        content.visibility = if (skeleton) View.GONE else View.VISIBLE
        if (skeleton) { content.removeAllViews(); pulse(loading, true); return }
        pulse(loading, false)
        timelineChips = null; timelineBody = null
        val view = when (mode) {
            ViewMode.AGENDA -> agendaView(weekData.events, animate)
            ViewMode.TIMELINE -> timelineView(weekData.events)
            ViewMode.WEEK -> weekView(weekData.events)
            ViewMode.MONTH -> monthView(monthEvents)
        }
        if (fadeThrough) fadeThrough(content, view) else slideIn(content, view, animate, forward)
    }

    // ---- Seznam (agenda) ----

    private fun agendaView(items: List<Lesson>, animate: Boolean) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        val headers = mutableListOf<View>()
        val tabs = LinearLayout(this@MainActivity).apply { setPadding(0, dp(4), 0, dp(4)) }
        addView(tabs)
        var order = 0
        val days = daysOf(week, items)
        days.forEach { day ->
            val header = dayHeader(day)
            headers += header
            addView(header)
            val daily = items.filter { it.date == day.toString() }
            if (daily.isEmpty()) addView(emptyDay()) else daily.forEach { addView(lessonCard(it, if (animate) order++ else -1)) }
        }
        days.forEachIndexed { index, day ->
            tabs.addView(dayChip(day, day == LocalDate.now()) { scrollToView(headers[index]) }, LinearLayout.LayoutParams(0, dp(50)).apply { weight = 1f; if (index != days.lastIndex) rightMargin = dp(5) })
        }
    }

    private fun scrollToView(target: View) {
        val rect = Rect(); target.getDrawingRect(rect); scroll.offsetDescendantRectToMyCoords(target, rect)
        scroll.smoothScrollTo(0, max(0, rect.top - dp(12)))
    }

    private fun dayHeader(day: LocalDate) = LinearLayout(this).apply {
        gravity = Gravity.CENTER_VERTICAL
        setPadding(0, dp(22), 0, dp(10))
        addView(label(day.format(DateTimeFormatter.ofPattern("EEEE", slovene)).replaceFirstChar { it.titlecase(slovene) }, 18f, color(R.color.ink), Typeface.BOLD))
        addView(label(day.format(shortDate), 13f, color(R.color.muted), Typeface.NORMAL).apply { setPadding(dp(8), 0, 0, 0) }, LinearLayout.LayoutParams(0, WRAP).apply { weight = 1f })
        if (day == LocalDate.now()) addView(tag("DANES", color(R.color.today_fill), color(R.color.today_text)).apply { setPadding(dp(8), dp(4), dp(8), dp(4)) })
    }

    private fun emptyDay() = TextView(this).apply {
        text = "Brez obveznosti"
        setTextColor(color(R.color.muted)); textSize = 14f
        setPadding(dp(16), dp(16), dp(16), dp(16))
        background = rounded(color(R.color.empty_fill), color(R.color.divider), 14)
        layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(4) }
    }

    private fun lessonCard(lesson: Lesson, order: Int): View {
        val palette = palette(lesson); val now = isNow(lesson) && !lesson.cancelled; val past = isPast(lesson)
        val dim = if (lesson.cancelled) .55f else if (past) .62f else 1f
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(15), dp(14), dp(14), dp(14))
            background = rounded(palette.fill, if (now) palette.text else palette.edge, 18, if (now) 2 else 1)
            isClickable = true; isFocusable = true; foreground = selectableForeground(); contentDescription = "${lesson.title}, ${lesson.start} do ${lesson.end}"
            setOnClickListener { showLesson(lesson) }
            alpha = dim
            addView(LinearLayout(this@MainActivity).apply {
                gravity = Gravity.TOP
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(label(lesson.start, 15f, palette.text, Typeface.BOLD).apply { typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD) })
                    addView(label(lesson.end, 12f, color(R.color.muted), Typeface.NORMAL).apply { typeface = Typeface.MONOSPACE; setPadding(0, dp(3), 0, 0) })
                }, LinearLayout.LayoutParams(dp(64), WRAP))
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(label(lesson.title, 17f, color(R.color.ink), Typeface.BOLD).apply { setLineSpacing(0f, 1.04f); strike(this, lesson.cancelled) })
                    if (lesson.cancelled) addView(label(listOf("Odpade", lesson.cancelNote).filter { it.isNotBlank() }.joinToString(" · "), 13f, color(R.color.warning), Typeface.BOLD).apply { setPadding(0, dp(5), 0, 0) })
                    else addView(iconLine(R.drawable.ic_pin, lesson.room.ifBlank { "Prostor ni znan" }).apply { setPadding(0, dp(6), 0, 0) })
                    addView(LinearLayout(this@MainActivity).apply {
                        setPadding(0, dp(10), 0, 0)
                        addView(tag(lesson.source.ifBlank { "IŠRM" }, palette.tag, palette.text).apply { setPadding(dp(8), dp(4), dp(8), dp(4)) })
                        if (lesson.type.isNotBlank()) addView(tag(lesson.type, color(R.color.surface), color(R.color.muted)).apply { setPadding(dp(8), dp(4), dp(8), dp(4)) }, LinearLayout.LayoutParams(WRAP, WRAP).apply { leftMargin = dp(6) })
                        if (now) addView(tag("ZDAJ", color(R.color.now_line), color(R.color.on_accent)).apply { setPadding(dp(8), dp(4), dp(8), dp(4)) }, LinearLayout.LayoutParams(WRAP, WRAP).apply { leftMargin = dp(6) })
                        if (lesson.cancelled) addView(tag("ODPADE", color(R.color.warning), color(R.color.on_accent)).apply { setPadding(dp(8), dp(4), dp(8), dp(4)) }, LinearLayout.LayoutParams(WRAP, WRAP).apply { leftMargin = dp(6) })
                    })
                }, LinearLayout.LayoutParams(0, WRAP).apply { weight = 1f })
            })
            if (now) addView(progress(lesson, palette), LinearLayout.LayoutParams(MATCH, dp(4)).apply { topMargin = dp(12) })
            layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(8) }
            pressable(this)
            if (order >= 0) {
                val target = dim
                alpha = 0f; translationY = dp(16).toFloat(); scaleX = .97f; scaleY = .97f
                animate().alpha(target).translationY(0f).scaleX(1f).scaleY(1f).setStartDelay(60L + order.coerceAtMost(8) * 40L).setDuration(420L).setInterpolator(EMPHASIZED).start()
            }
        }
    }

    // How far into the current lesson we are, as a thin bar — the at-a-glance answer to "how long until this ends".
    private fun progress(lesson: Lesson, palette: Palette) = FrameLayout(this).apply {
        background = rounded(palette.edge, palette.edge, 2)
        val done = ((nowMinutes() - minutes(lesson.start)).toFloat() / max(1, minutes(lesson.end) - minutes(lesson.start))).coerceIn(0f, 1f)
        addView(View(this@MainActivity).apply { background = rounded(palette.text, palette.text, 2) }, FrameLayout.LayoutParams(0, MATCH))
        post { getChildAt(0).layoutParams = FrameLayout.LayoutParams((width * done).roundToInt(), MATCH); getChildAt(0).requestLayout() }
    }

    // ---- Časovni (one day on a time axis) ----

    private fun timelineView(items: List<Lesson>) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        val chips = LinearLayout(this@MainActivity)
        val body = FrameLayout(this@MainActivity).apply { clipChildren = false }
        clipChildren = false
        timelineChips = chips; timelineBody = body
        addView(withPill(chips, dp(50), 12, MATCH), LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(4) })
        addView(body, LinearLayout.LayoutParams(MATCH, WRAP))
        fillTimelineChips()
        body.addView(timelineDay(items))
    }

    private fun fillTimelineChips() {
        val chips = timelineChips ?: return
        chips.removeAllViews()
        val days = daysOf(week, weekData.events)
        days.forEachIndexed { index, day ->
            chips.addView(dayChip(day, index == timelineDayIndex) { showTimelineDay(index) }, LinearLayout.LayoutParams(0, dp(50)).apply { weight = 1f; if (index != days.lastIndex) rightMargin = dp(5) })
        }
        movePill(chips, chips.getChildAt(timelineDayIndex), false)
    }

    private fun timelineDay(items: List<Lesson>) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        val days = daysOf(week, items)
        val day = days[timelineDayIndex.coerceIn(0, days.lastIndex)]
        addView(dayHeader(day))
        val daily = items.filter { it.date == day.toString() }
        addView(timeGrid(listOf(day), contentWidth(), daily, compact = false))
        if (daily.isEmpty()) addView(label("Ta dan ni obveznosti.", 13f, color(R.color.muted), Typeface.NORMAL).apply { setPadding(0, dp(12), 0, 0) })
    }

    // Moving within the week: the day buttons only change their highlight, the day itself slides in from the side it came from.
    private fun showTimelineDay(index: Int) {
        val body = timelineBody
        if (mode != ViewMode.TIMELINE || body == null) { timelineDayIndex = index; render(animate = false); return }
        if (index == timelineDayIndex) return
        val forward = index > timelineDayIndex
        timelineDayIndex = index
        val days = daysOf(week, weekData.events)
        timelineChips?.let { chips -> repeat(chips.childCount) { i -> styleDayChip(chips.getChildAt(i) as TextView, days[i], i == index, animate = true) }; movePill(chips, chips.getChildAt(index), true) }
        tick()
        slideIn(body, timelineDay(weekData.events), true, forward)
    }

    // ---- Teden (five days on one time axis, like the website's week grid) ----

    private fun weekView(items: List<Lesson>): View {
        // Always exactly the screen width: five equal columns, no sideways scrolling, so swiping always means "next week".
        val axis = dp(32)
        val width = contentWidth()
        val days = daysOf(week, items)
        val columnWidth = (width - axis) / days.size
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(4), 0, 0)
            addView(LinearLayout(this@MainActivity).apply {
                addView(View(this@MainActivity), LinearLayout.LayoutParams(axis, 1))
                days.forEach { day ->
                    val today = day == LocalDate.now()
                    addView(LinearLayout(this@MainActivity).apply {
                        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(0, dp(5), 0, dp(5))
                        if (today) background = rounded(color(R.color.today_fill), color(R.color.today_fill), 10)
                        addView(label(weekday(day), 10f, color(if (today) R.color.today_text else R.color.muted), Typeface.BOLD).apply { gravity = Gravity.CENTER })
                        addView(label(day.dayOfMonth.toString(), 15f, color(if (today) R.color.today_text else R.color.ink), Typeface.BOLD).apply { gravity = Gravity.CENTER })
                    }, LinearLayout.LayoutParams(columnWidth, WRAP))
                }
            })
            addView(timeGrid(days, width, items, compact = true, axis = axis), LinearLayout.LayoutParams(width, WRAP).apply { topMargin = dp(6) })
        }
    }

    private fun timeGrid(days: List<LocalDate>, width: Int, items: List<Lesson>, compact: Boolean, axis: Int = dp(40)): View {
        val hourHeight = dp(if (compact) 54 else 64); val firstHour = 7; val totalHours = 14
        val height = hourHeight * totalHours
        val columnWidth = (width - axis) / days.size
        return FrameLayout(this).apply {
            (0 until totalHours).forEach { offset ->
                addView(label("${(firstHour + offset).toString().padStart(2, '0')}:00", 9f, color(R.color.muted), Typeface.BOLD).apply { typeface = Typeface.MONOSPACE }, FrameLayout.LayoutParams(axis, WRAP).apply { topMargin = max(0, offset * hourHeight - dp(5)) })
            }
            addView(FrameLayout(this@MainActivity).apply {
                background = rounded(color(R.color.surface), color(R.color.surface_edge), 16)
                (1 until totalHours).forEach { offset -> addView(View(this@MainActivity).apply { setBackgroundColor(color(R.color.divider)) }, FrameLayout.LayoutParams(MATCH, dp(1)).apply { topMargin = offset * hourHeight }) }
                (1 until days.size).forEach { index -> addView(View(this@MainActivity).apply { setBackgroundColor(color(R.color.divider)) }, FrameLayout.LayoutParams(dp(1), MATCH).apply { leftMargin = index * columnWidth }) }
                days.forEachIndexed { dayIndex, day ->
                    layoutTimed(items.filter { it.date == day.toString() }).forEach { timed ->
                        val top = ((timed.start - firstHour * 60).coerceAtLeast(0) / 60f * hourHeight).roundToInt()
                        val eventHeight = max(dp(if (compact) 30 else 44), ((timed.end - timed.start) / 60f * hourHeight).roundToInt() - dp(3))
                        val slot = columnWidth / timed.columns
                        addView(timelineEvent(timed.lesson, compact), FrameLayout.LayoutParams(slot - dp(4), eventHeight).apply { leftMargin = dayIndex * columnWidth + timed.column * slot + dp(2); topMargin = top + dp(2) })
                    }
                    if (day == LocalDate.now() && nowMinutes() in firstHour * 60 until (firstHour + totalHours) * 60) {
                        val y = ((nowMinutes() - firstHour * 60) / 60f * hourHeight).roundToInt()
                        addView(View(this@MainActivity).apply { setBackgroundColor(color(R.color.now_line)) }, FrameLayout.LayoutParams(columnWidth, dp(2)).apply { leftMargin = dayIndex * columnWidth; topMargin = y })
                        addView(View(this@MainActivity).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color(R.color.now_line)) }; breathe(this) }, FrameLayout.LayoutParams(dp(8), dp(8)).apply { leftMargin = dayIndex * columnWidth; topMargin = y - dp(3) })
                    }
                }
            }, FrameLayout.LayoutParams(width - axis, height).apply { leftMargin = axis })
            layoutParams = LinearLayout.LayoutParams(width, height + dp(4))
        }
    }

    private fun timelineEvent(lesson: Lesson, compact: Boolean) = TextView(this).apply {
        val palette = palette(lesson)
        text = if (compact) "${lesson.start}\n${lesson.title}" else "${lesson.start}–${lesson.end}\n${lesson.title}\n${lesson.room}"
        setTextColor(color(R.color.ink)); textSize = if (compact) 9f else 12f; setTypeface(Typeface.create("sans-serif", Typeface.BOLD))
        setLineSpacing(0f, if (compact) 1f else 1.05f); setPadding(dp(if (compact) 4 else 9), dp(if (compact) 3 else 5), dp(2), dp(3))
        if (compact) { ellipsize = android.text.TextUtils.TruncateAt.END; breakStrategy = android.text.Layout.BREAK_STRATEGY_SIMPLE }
        background = rounded(palette.fill, if (isNow(lesson) && !lesson.cancelled) palette.text else palette.edge, 9, if (isNow(lesson) && !lesson.cancelled) 2 else 1)
        if (lesson.cancelled) { strike(this, true); alpha = .5f; text = "ODPADE · $text" }
        isClickable = true; isFocusable = true; foreground = selectableForeground(); contentDescription = "Podrobnosti: ${lesson.title}"
        setOnClickListener { showLesson(lesson) }
        pressable(this)
    }

    // ---- Mesec ----

    private fun monthView(items: List<Lesson>) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(0, dp(4), 0, 0)
        val gap = dp(4)
        // Weekend columns appear only in a month that has a weekend event.
        val columns = if (items.any { runCatching { LocalDate.parse(it.date).dayOfWeek.value >= 6 }.getOrDefault(false) }) 7 else 5
        val cellWidth = (contentWidth() - gap * (columns - 1)) / columns
        addView(LinearLayout(this@MainActivity).apply {
            listOf("Pon", "Tor", "Sre", "Čet", "Pet", "Sob", "Ned").take(columns).forEachIndexed { index, name -> addView(label(name, 10f, color(R.color.muted), Typeface.BOLD).apply { gravity = Gravity.CENTER; letterSpacing = .04f }, LinearLayout.LayoutParams(cellWidth, dp(26)).apply { if (index != columns - 1) rightMargin = gap }) }
        })
        val byDay = items.groupBy { it.date }
        val grid = GridLayout(this@MainActivity).apply { columnCount = columns }
        monthDays(monthAnchor, columns).forEachIndexed { index, day ->
            val inMonth = day.month == monthAnchor.month
            val today = day == LocalDate.now()
            val daily = byDay[day.toString()].orEmpty()
            val cell = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(4), dp(5), dp(4), dp(4))
                background = rounded(color(if (inMonth) R.color.surface else R.color.empty_fill), color(if (today) R.color.accent else R.color.surface_edge), 10, if (today) 2 else 1)
                alpha = if (inMonth) 1f else .45f
                isClickable = true; isFocusable = true; foreground = selectableForeground(); contentDescription = "Odpri ${day.format(shortDate)}"
                setOnClickListener { openDay(day) }
                pressable(this)
                addView(label(day.dayOfMonth.toString(), 12f, color(if (today) R.color.today_text else R.color.ink), Typeface.BOLD).apply { setPadding(dp(2), 0, 0, dp(2)) })
                daily.take(3).forEach { addView(monthEvent(it)) }
                if (daily.size > 3) addView(label("+${daily.size - 3}", 9f, color(R.color.muted), Typeface.BOLD).apply { setPadding(dp(3), dp(2), 0, 0) })
            }
            grid.addView(cell, GridLayout.LayoutParams().apply { width = cellWidth; height = dp(108); setMargins(0, 0, if (index % columns == columns - 1) 0 else gap, gap) })
        }
        addView(grid)
    }

    private fun monthEvent(lesson: Lesson) = TextView(this).apply {
        val palette = palette(lesson)
        text = "${lesson.start} ${lesson.title}"
        setTextColor(palette.text); textSize = 8f; setTypeface(Typeface.create("sans-serif", Typeface.BOLD)); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
        setPadding(dp(3), dp(3), dp(2), dp(3)); background = rounded(palette.fill, palette.fill, 5)
        if (lesson.cancelled) { strike(this, true); alpha = .5f }
        layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(3) }
        isClickable = true; setOnClickListener { showLesson(lesson) }
    }

    // Same as the website: tapping a day in the month opens that day on the time axis.
    private fun openDay(day: LocalDate) {
        week = day.with(DayOfWeek.MONDAY)
        timelineDayIndex = daysOf(week, monthEvents + weekData.events).indexOf(day).coerceAtLeast(0)
        mode = ViewMode.TIMELINE; prefs.edit().putString("view", mode.name).apply(); updateViewSwitcher()
        loadWeek(false, true)
    }

    private fun layoutTimed(items: List<Lesson>): List<TimedLesson> {
        val groups = mutableListOf<MutableList<Lesson>>()
        var group = mutableListOf<Lesson>(); var groupEnd = -1
        items.sortedBy { minutes(it.start) }.forEach { lesson ->
            if (group.isNotEmpty() && minutes(lesson.start) >= groupEnd) { groups += group; group = mutableListOf(); groupEnd = -1 }
            group += lesson; groupEnd = max(groupEnd, minutes(lesson.end))
        }
        if (group.isNotEmpty()) groups += group
        return groups.flatMap { overlap ->
            val columns = mutableListOf<Int>()
            val placed = overlap.map { lesson ->
                val start = minutes(lesson.start); val end = minutes(lesson.end)
                var column = columns.indexOfFirst { it <= start }
                if (column < 0) { column = columns.size; columns += end } else columns[column] = end
                Triple(lesson, start to end, column)
            }
            placed.map { (lesson, span, column) -> TimedLesson(lesson, span.first, span.second, column, columns.size) }
        }
    }

    private fun monthDays(anchor: LocalDate, columns: Int): List<LocalDate> {
        val month = YearMonth.from(anchor)
        val start = month.atDay(1).with(DayOfWeek.MONDAY)
        val last = month.atEndOfMonth()
        val end = last.with(java.time.temporal.TemporalAdjusters.nextOrSame(DayOfWeek.SUNDAY))
        return generateSequence(start) { if (it >= end) null else it.plusDays(1) }.filter { it.dayOfWeek.value <= columns }.toList()
    }

    // ---- Sheets ----

    private fun showLesson(lesson: Lesson) {
        val palette = palette(lesson)
        val date = runCatching { LocalDate.parse(lesson.date) }.getOrNull()
        sheet { dialog ->
            addView(LinearLayout(this@MainActivity).apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(tag(lesson.source.ifBlank { "IŠRM" }, palette.tag, palette.text).apply { setPadding(dp(9), dp(5), dp(9), dp(5)) })
                addView(label(faculty(lesson.source), 13f, color(R.color.muted), Typeface.NORMAL).apply { setPadding(dp(9), 0, 0, 0) })
            })
            addView(label(lesson.title, 26f, color(R.color.ink), Typeface.BOLD).apply { setLineSpacing(0f, 1.04f); setPadding(0, dp(14), 0, 0); strike(this, lesson.cancelled) })
            if (lesson.cancelled) addView(label(listOf("Ta termin odpade", lesson.cancelNote).filter { it.isNotBlank() }.joinToString(" · "), 14f, color(R.color.on_accent), Typeface.BOLD).apply { setPadding(dp(13), dp(10), dp(13), dp(10)); background = rounded(color(R.color.warning), color(R.color.warning), 12) }, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(12) })
            if (lesson.type.isNotBlank()) addView(label(typeName(lesson.type), 15f, palette.text, Typeface.BOLD).apply { setPadding(0, dp(6), 0, 0) })
            addView(detailRow("TERMIN", "${date?.format(longDate)?.replaceFirstChar { it.titlecase(slovene) } ?: lesson.date}\n${lesson.start}–${lesson.end}", palette), LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(20) })
            addView(detailRow("PROSTOR", lesson.room.ifBlank { "Ni podatka" }, palette), LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(8) })
            addView(detailRow("IZVAJALEC", lesson.teacher.ifBlank { "Ni podatka" }, palette), LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(8) })
            if (date != null && !lesson.cancelled) addView(secondaryButton("Dodaj v svoj koledar") { dialog.dismiss(); addToCalendar(lesson, date) }, LinearLayout.LayoutParams(MATCH, dp(50)).apply { topMargin = dp(18) })
            if (canEdit) adminLessonActions(lesson, dialog)
        }
    }

    /** Admin-only: delete an own event, or mark a faculty lecture (this date only) as cancelled for the whole year. */
    private fun LinearLayout.adminLessonActions(lesson: Lesson, dialog: BottomSheetDialog) {
        addView(section("UREJANJE · ADMIN"))
        val message = label("", 12f, color(R.color.warning), Typeface.BOLD).apply { setPadding(0, dp(8), 0, 0) }
        val password = adminToken()
        val custom = lesson.source != "FRI" && lesson.source != "FMF"
        if (custom) {
            addView(secondaryButton("Izbriši dogodek") {
                AlertDialog.Builder(this@MainActivity).setTitle("Izbrišem dogodek?").setMessage("»${lesson.title}« bo izbrisan za ves letnik.")
                    .setNegativeButton("Prekliči", null)
                    .setPositiveButton("Izbriši") { _, _ -> adminAction(message, dialog, "Dogodek je izbrisan.") { repo.adminDeleteEvent(password, lesson.id) } }.show()
            }.apply { setTextColor(color(R.color.warning)) }, LinearLayout.LayoutParams(MATCH, dp(50)))
        } else if (lesson.cancelled) {
            addView(secondaryButton("Prekliči odpad · predavanje bo") { adminAction(message, dialog, "Predavanje je spet na urniku.") { repo.adminCancel(password, year, lesson, false, "") } }, LinearLayout.LayoutParams(MATCH, dp(50)))
        } else {
            val note = input("Opomba, npr. »nadomeščanje v petek« (neobvezno)", "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES)
            addView(note, LinearLayout.LayoutParams(MATCH, dp(52)))
            addView(secondaryButton("Označi kot odpadlo") { adminAction(message, dialog, "Označeno kot odpadlo za ves $year. letnik.") { repo.adminCancel(password, year, lesson, true, note.text.toString().trim()) } }
                .apply { setTextColor(color(R.color.warning)) }, LinearLayout.LayoutParams(MATCH, dp(50)).apply { topMargin = dp(8) })
        }
        addView(message)
    }

    /** Runs an admin request off the main thread, then closes the sheet and reloads so everyone's view matches. */
    private fun adminAction(message: TextView, dialog: BottomSheetDialog, done: String, request: () -> Unit) {
        message.text = "Shranjujem …"
        executor.execute {
            val result = runCatching { request() }
            runOnUiThread {
                result.onSuccess { dialog.dismiss(); toast(done); reload(true) }.onFailure { message.text = friendly(it) }
            }
        }
    }

    private fun addToCalendar(lesson: Lesson, date: LocalDate) {
        val zone = ZoneId.systemDefault()
        val begin = date.atTime(LocalTime.parse(lesson.start)).atZone(zone).toInstant().toEpochMilli()
        val end = date.atTime(LocalTime.parse(lesson.end)).atZone(zone).toInstant().toEpochMilli()
        val intent = Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin).putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end)
            .putExtra(CalendarContract.Events.TITLE, lesson.title).putExtra(CalendarContract.Events.EVENT_LOCATION, lesson.room)
            .putExtra(CalendarContract.Events.DESCRIPTION, listOf(typeName(lesson.type), lesson.teacher, lesson.source).filter { it.isNotBlank() }.joinToString(" · "))
        try { startActivity(intent) } catch (_: ActivityNotFoundException) { toast("Na napravi ni aplikacije za koledar.") }
    }

    private fun detailRow(name: String, value: String, palette: Palette) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(dp(15), dp(13), dp(15), dp(14)); background = rounded(palette.fill, palette.edge, 14)
        addView(label(name, 10f, color(R.color.muted), Typeface.BOLD).apply { letterSpacing = 0.1f })
        addView(label(value, 16f, color(R.color.ink), Typeface.BOLD).apply { setPadding(0, dp(5), 0, 0); setLineSpacing(0f, 1.1f) })
    }

    private fun showSettings() = sheet { dialog ->
        addView(kicker("NASTAVITVE"))
        addView(label("Program", 25f, color(R.color.ink), Typeface.BOLD).apply { setPadding(0, dp(6), 0, 0) })
        addView(section("LETNIK"))
        val years = segmented(listOf("1" to "1. letnik", "2" to "2. letnik", "3" to "3. letnik"), year) { chosen -> prefs.edit().putString("year", chosen).apply(); reload(false) }
        addView(years)

        addView(section("VPISNA ŠTEVILKA · NEOBVEZNO"))
        val number = input("Za osebni urnik", student, InputType.TYPE_CLASS_NUMBER)
        addView(number, LinearLayout.LayoutParams(MATCH, dp(52)))
        addView(label("Izbere tvojo FRI skupino pri prekrivanju vaj.", 12f, color(R.color.muted), Typeface.NORMAL).apply { setPadding(0, dp(6), 0, 0) })
        val message = label(if (student.isNotBlank()) "Osebni urnik je vključen." else "Shranjeno samo v tej napravi.", 12f, color(R.color.muted), Typeface.BOLD).apply { setPadding(0, dp(8), 0, 0) }
        addView(LinearLayout(this@MainActivity).apply {
            setPadding(0, dp(10), 0, 0)
            addView(primaryButton("Shrani") { saveStudent(number.text.toString().filter(Char::isDigit), message) { chosen -> refreshSegmented(years, chosen) } }, LinearLayout.LayoutParams(0, dp(46)).apply { weight = 1f })
            addView(secondaryButton("Odstrani") { number.setText(""); prefs.edit().remove("student").apply(); message.text = "Osebni urnik je izključen."; reload(false) }, LinearLayout.LayoutParams(0, dp(46)).apply { weight = 1f; leftMargin = dp(8) })
        })
        addView(message)

        addView(section("VIDEZ"))
        addView(segmented(listOf("system" to "Sistem", "light" to "Svetlo", "dark" to "Temno"), prefs.getString("theme", "system") ?: "system") { chosen -> dialog.dismiss(); applyTheme(chosen) })

        addView(section("KOLEDAR .ICS"))
        addView(label(if (student.isNotBlank()) "Naročniška povezava vključuje tvoje FRI vaje in se sama posodablja." else "Naročniška povezava se sama posodablja.", 13f, color(R.color.muted), Typeface.NORMAL))
        val subscription = repo.subscriptionUrl(year, student)
        addView(LinearLayout(this@MainActivity).apply {
            setPadding(0, dp(10), 0, 0)
            addView(secondaryButton("Kopiraj povezavo") { (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("IŠRM koledar", subscription)); toast("Povezava kopirana.") }, LinearLayout.LayoutParams(0, dp(46)).apply { weight = 1f })
            addView(secondaryButton("Deli") { startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, subscription), "Deli koledar")) }, LinearLayout.LayoutParams(0, dp(46)).apply { weight = .6f; leftMargin = dp(8) })
        })
        addView(secondaryButton("Prenesi ta teden (.ics)") { dialog.dismiss(); open(repo.calendarUrl(week, year, student)) }, LinearLayout.LayoutParams(MATCH, dp(46)).apply { topMargin = dp(8) })

        addView(section("UREJANJE · ADMIN"))
        if (adminUnlocked) {
            addView(LinearLayout(this@MainActivity).apply {
                gravity = Gravity.CENTER_VERTICAL; setPadding(dp(15), dp(10), dp(8), dp(10))
                background = rounded(color(if (editMode) R.color.today_fill else R.color.surface), color(R.color.surface_edge), 14)
                val texts = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
                texts.addView(label("Urejanje urnika", 16f, color(R.color.ink), Typeface.BOLD))
                val hint = label(if (editMode) "Vključeno: + spodaj desno, brisanje in odpadla predavanja." else "Izključeno: urnika ni mogoče po nesreči spremeniti.", 12f, color(R.color.muted), Typeface.NORMAL).apply { setPadding(0, dp(3), 0, 0) }
                texts.addView(hint)
                addView(texts, LinearLayout.LayoutParams(0, WRAP).apply { weight = 1f })
                val row = this
                addView(com.google.android.material.switchmaterial.SwitchMaterial(this@MainActivity).apply {
                    isChecked = editMode; contentDescription = "Urejanje urnika"
                    setOnCheckedChangeListener { _, checked ->
                        editMode = checked; tick(); updateAdmin(); renderAnnouncements()
                        hint.text = if (checked) "Vključeno: + spodaj desno, brisanje in odpadla predavanja." else "Izključeno: urnika ni mogoče po nesreči spremeniti."
                        row.background = rounded(color(if (checked) R.color.today_fill else R.color.surface), color(R.color.surface_edge), 14)
                    }
                })
            })
            addView(label("Ob vsakem zagonu aplikacije se urejanje izklopi. Dostop je shranjen na tej napravi, geslo pa ne.", 12f, color(R.color.muted), Typeface.NORMAL).apply { setPadding(0, dp(8), 0, 0) })
            addView(secondaryButton("Odstrani dostop") { dialog.dismiss(); removeAdminAccess() }.apply { setTextColor(color(R.color.warning)) }, LinearLayout.LayoutParams(MATCH, dp(46)).apply { topMargin = dp(10) })
        } else {
            // Never pre-filled: the password is only sent once to get a key and is not kept anywhere.
            val password = input("Geslo za urejanje", "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
            val adminMessage = label("", 12f, color(R.color.warning), Typeface.BOLD).apply { setPadding(0, dp(8), 0, 0) }
            addView(password, LinearLayout.LayoutParams(MATCH, dp(52)))
            addView(secondaryButton("Odpri urejanje") { unlockAdmin(password.text.toString(), adminMessage, dialog) }, LinearLayout.LayoutParams(MATCH, dp(46)).apply { topMargin = dp(10) })
            addView(adminMessage)
        }
        addView(secondaryButton("Preveri posodobitve") { dialog.dismiss(); checkRelease(manual = true) }, LinearLayout.LayoutParams(MATCH, dp(46)).apply { topMargin = dp(22) })
        addView(manualDownloadLink("Ročni prenos najnovejše različice"), LinearLayout.LayoutParams(MATCH, dp(44)).apply { topMargin = dp(4) })
        addView(label("Politika zasebnosti", 13f, color(R.color.accent), Typeface.BOLD).apply { setPadding(0, dp(24), 0, dp(4)); isClickable = true; setOnClickListener { open("${BuildConfig.WEB_APP_URL.trimEnd('/')}/privacy") } })
        addView(label("Različica ${BuildConfig.VERSION_NAME} · posodobljeno ${buildDate()}", 12f, color(R.color.ink), Typeface.BOLD))
        addView(label("Brez računov, oglasov in sledenja.", 11f, color(R.color.muted), Typeface.NORMAL).apply { setPadding(0, dp(2), 0, 0) })
    }

    // ---- Messages from the admin ----

    private fun renderAnnouncements() {
        val box = findViewById<LinearLayout>(R.id.announcements)
        val dismissed = prefs.getStringSet("dismissed-messages", emptySet()) ?: emptySet()
        val visible = weekData.announcements.filter { it.id !in dismissed }
        val signature = visible.joinToString { it.id } + canEdit
        if (box.tag == signature) return
        box.tag = signature
        box.removeAllViews()
        visible.forEach { note ->
            box.addView(LinearLayout(this).apply {
                gravity = Gravity.TOP; setPadding(dp(15), dp(13), dp(8), dp(13))
                background = rounded(color(R.color.today_fill), color(R.color.today_fill), 16)
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.VERTICAL
                    val day = runCatching { Instant.parse(note.createdAt).atZone(ZoneId.systemDefault()).toLocalDate().format(shortDate) }.getOrDefault("")
                    addView(kicker("SPOROČILO${if (day.isNotBlank()) " · $day" else ""}").apply { setTextColor(color(R.color.today_text)) })
                    addView(label(note.text, 15f, color(R.color.ink), Typeface.NORMAL).apply { setPadding(0, dp(5), 0, 0); setLineSpacing(0f, 1.15f) })
                    if (canEdit) addView(label("Izbriši za vse", 12f, color(R.color.warning), Typeface.BOLD).apply {
                        setPadding(0, dp(8), 0, 0); isClickable = true
                        setOnClickListener { confirmDeleteAnnouncement(note) }
                    })
                }, LinearLayout.LayoutParams(0, WRAP).apply { weight = 1f })
                addView(label("✕", 15f, color(R.color.muted), Typeface.BOLD).apply {
                    gravity = Gravity.CENTER; isClickable = true; contentDescription = "Skrij sporočilo"
                    setOnClickListener {
                        prefs.edit().putStringSet("dismissed-messages", dismissed + note.id).apply()
                        (parent as View).animate().alpha(0f).translationY(-dp(6).toFloat()).setDuration(180L).withEndAction { box.tag = null; renderAnnouncements() }.start()
                    }
                }, LinearLayout.LayoutParams(dp(36), dp(36)))
            }, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(12) })
        }
    }

    private fun confirmDeleteAnnouncement(note: Announcement) {
        AlertDialog.Builder(this).setTitle("Izbrišem sporočilo?").setMessage("Sporočilo bo izginilo vsem v $year. letniku.")
            .setNegativeButton("Prekliči", null)
            .setPositiveButton("Izbriši") { _, _ ->
                val password = adminToken()
                executor.execute {
                    val result = runCatching { repo.adminDeleteAnnouncement(password, note.id) }
                    runOnUiThread { result.onSuccess { toast("Sporočilo je izbrisano."); reload(true) }.onFailure { toast(friendly(it)) } }
                }
            }.show()
    }

    private fun showAdminMenu() = sheet { dialog ->
        addView(kicker("UREJANJE · $year. LETNIK"))
        addView(label("Kaj želiš dodati?", 25f, color(R.color.ink), Typeface.BOLD).apply { setPadding(0, dp(6), 0, dp(16)) })
        addView(primaryButton("Nov dogodek") { dialog.dismiss(); showComposer() }, LinearLayout.LayoutParams(MATCH, dp(54)))
        addView(secondaryButton("Sporočilo za letnik") { dialog.dismiss(); showMessageComposer() }, LinearLayout.LayoutParams(MATCH, dp(54)).apply { topMargin = dp(8) })
        addView(label("Predavanje označiš kot odpadlo tako, da ga tapneš na urniku.", 12f, color(R.color.muted), Typeface.NORMAL).apply { setPadding(0, dp(14), 0, 0) })
    }

    private fun showMessageComposer() = sheet { dialog ->
        var days = 3
        addView(kicker("ZA VSE V $year. LETNIKU"))
        addView(label("Novo sporočilo", 25f, color(R.color.ink), Typeface.BOLD).apply { setPadding(0, dp(6), 0, dp(6)) })
        addView(label("Prikaže se na vrhu urnika v aplikaciji in na spletu.", 14f, color(R.color.muted), Typeface.NORMAL))
        addView(section("SPOROČILO"))
        val text = EditText(this@MainActivity).apply {
            hint = "Npr. Jutri predavanje iz Analize odpade."; minLines = 3; maxLines = 6; gravity = Gravity.TOP or Gravity.START
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            textSize = 15f; setTextColor(color(R.color.ink)); setHintTextColor(color(R.color.muted)); setBackgroundResource(R.drawable.input_surface); setPadding(dp(14), dp(12), dp(14), dp(12))
            typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        }
        addView(text, LinearLayout.LayoutParams(MATCH, WRAP))
        addView(section("VIDNO"))
        addView(segmented(listOf("1" to "1 dan", "3" to "3 dni", "7" to "1 teden", "14" to "2 tedna"), days.toString()) { days = it.toInt() })
        val message = label("", 12f, color(R.color.warning), Typeface.BOLD).apply { setPadding(0, dp(8), 0, 0) }
        addView(message)
        addView(primaryButton("Pošlji vsem v $year. letniku") {
            if (text.text.isBlank()) { message.text = "Vpiši sporočilo."; return@primaryButton }
            val password = adminToken()
            adminAction(message, dialog, "Sporočilo je objavljeno.") { repo.adminAnnounce(password, year, text.text.toString().trim(), days) }
        }, LinearLayout.LayoutParams(MATCH, dp(52)).apply { topMargin = dp(10) })
        text.requestFocus()
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE or WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    }

    private fun saveStudent(next: String, message: TextView, onProgramme: (String) -> Unit) {
        if (next.isEmpty()) { prefs.edit().remove("student").apply(); message.text = "Osebni urnik je izključen."; reload(false); return }
        if (next.length !in 6..16) { message.text = "Vnesi številko z 6–16 števkami."; return }
        message.text = "Preverjam letnik …"
        executor.execute {
            val result = runCatching { repo.studentProgramme(next) }
            runOnUiThread {
                result.onSuccess { programme ->
                    prefs.edit().putString("student", next).putString("year", programme).apply()
                    message.text = "Izbran je $programme. letnik. Osebni urnik je vključen."
                    onProgramme(programme); reload(false)
                }.onFailure { message.text = friendly(it) }
            }
        }
    }

    private fun adminToken() = prefs.getString("admin-token", "") ?: ""

    private fun unlockAdmin(password: String, message: TextView, dialog: BottomSheetDialog) {
        if (password.isBlank()) { message.text = "Vnesi geslo."; return }
        message.text = "Preverjam …"
        executor.execute {
            val result = runCatching { repo.adminLogin(password) }
            runOnUiThread {
                result.onSuccess { token -> prefs.edit().putString("admin-token", token).remove("admin").apply(); adminUnlocked = true; editMode = true; updateAdmin(); dialog.dismiss(); toast("Dostop je shranjen. Urejanje vklopiš ali izklopiš v nastavitvah.") }
                    .onFailure { message.text = friendly(it) }
            }
        }
    }

    /** Revokes this device's key on the server and forgets it here. */
    private fun removeAdminAccess() {
        val token = adminToken()
        prefs.edit().remove("admin-token").remove("admin").apply()
        adminUnlocked = false; updateAdmin(); toast("Dostop za urejanje je odstranjen.")
        if (token.isNotBlank()) background.execute { runCatching { repo.adminLogout(token) } }
    }

    // Versions before 2.1 saved the password itself; trade it for a key once and delete it.
    private fun migrateAdminPassword() {
        val legacy = prefs.getString("admin", null)?.takeIf { it.isNotBlank() } ?: return
        if (adminToken().isNotBlank()) { prefs.edit().remove("admin").apply(); return }
        background.execute {
            val token = runCatching { repo.adminLogin(legacy) }.getOrNull()
            runOnUiThread {
                prefs.edit().remove("admin").apply { if (token != null) putString("admin-token", token) }.apply()
                adminUnlocked = token != null; updateAdmin()
            }
        }
    }

    private fun updateAdmin() {
        if (!adminUnlocked) editMode = false
        addEvent.visibility = if (canEdit) View.VISIBLE else View.GONE
        if (::repo.isInitialized) updateHeader()
        if (::repo.isInitialized) renderAnnouncements()
        findViewById<View>(R.id.column).let { it.setPadding(it.paddingLeft, it.paddingTop, it.paddingRight, columnBottom()) }
    }

    // Room under the last lesson so the + button never covers it, only when that button is shown.
    private fun columnBottom() = (if (canEdit) dp(92) else dp(20)) + bottomInset

    /**
     * Adding an event is mostly taps: quick day and start-time chips plus a length, with a live summary of what will be
     * created. Pickers are only one tap away ("Drug dan", "Drug čas") for anything unusual.
     */
    private fun showComposer() = sheet { dialog ->
        val today = LocalDate.now()
        var date = if (week == thisMonday() && today.dayOfWeek.value <= 5) today else week
        var start = "10:00"; var length = 120
        val summary = label("", 16f, color(R.color.today_text), Typeface.BOLD)
        fun end() = LocalTime.parse(start).plusMinutes(length.toLong()).let { if (it.isBefore(LocalTime.parse(start))) LocalTime.of(23, 59) else it }.toString()
        fun refreshSummary() { summary.text = "${date.format(longDate).replaceFirstChar { it.titlecase(slovene) }} · $start–${end()}" }

        addView(kicker("ZA VSE V $year. LETNIKU"))
        addView(label("Nov dogodek", 25f, color(R.color.ink), Typeface.BOLD).apply { setPadding(0, dp(6), 0, dp(14)) })
        val title = input("Ime dogodka, npr. Kolokvij", "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES)
        addView(title, LinearLayout.LayoutParams(MATCH, dp(54)))

        addView(section("DAN"))
        val dayKey = { d: LocalDate -> when (d) { today -> "today"; today.plusDays(1) -> "tomorrow"; else -> "other" } }
        lateinit var days: LinearLayout
        days = choices(listOf("today" to "Danes", "tomorrow" to "Jutri", "other" to if (dayKey(date) == "other") date.format(shortDate) else "Drug dan …"), dayKey(date)) { picked ->
            when (picked) {
                "today" -> date = today
                "tomorrow" -> date = today.plusDays(1)
                else -> DatePickerDialog(this@MainActivity, { _, y, m, d -> date = LocalDate.of(y, m + 1, d); (days.findViewWithTag<TextView>("other")).text = date.format(shortDate); refreshSegmented(days, dayKey(date)); refreshSummary() }, date.year, date.monthValue - 1, date.dayOfMonth).show()
            }
            refreshSegmented(days, dayKey(date)); refreshSummary()
        }
        addView(days)

        addView(section("ZAČETEK"))
        val presets = listOf("08:00", "09:00", "10:00", "12:00", "14:00", "16:00", "18:00")
        lateinit var times: LinearLayout
        times = choices(presets.map { it to it } + ("other" to "Drug čas …"), start) { picked ->
            if (picked == "other") pickTime(start) { chosen -> start = chosen; (times.findViewWithTag<TextView>("other")).text = if (chosen in presets) "Drug čas …" else chosen; refreshSegmented(times, if (chosen in presets) chosen else "other"); refreshSummary() }
            else { start = picked; times.findViewWithTag<TextView>("other").text = "Drug čas …"; refreshSegmented(times, picked) }
            refreshSummary()
        }
        addView(HorizontalScrollView(this@MainActivity).apply { isHorizontalScrollBarEnabled = false; addView(times) })

        addView(section("TRAJANJE"))
        addView(segmented(listOf("60" to "1 h", "90" to "1,5 h", "120" to "2 h", "180" to "3 h"), length.toString()) { picked -> length = picked.toInt(); refreshSummary() })

        addView(section("PROSTOR · NEOBVEZNO"))
        val room = input("Npr. P.01", "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS)
        addView(room, LinearLayout.LayoutParams(MATCH, dp(52)))

        addView(LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(15), dp(13), dp(15), dp(13)); background = rounded(color(R.color.today_fill), color(R.color.today_fill), 14)
            addView(kicker("USTVARIL BOŠ"))
            addView(summary.apply { setPadding(0, dp(4), 0, 0) })
        }, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(20) })
        refreshSummary()
        val message = label("", 12f, color(R.color.warning), Typeface.BOLD).apply { setPadding(0, dp(8), 0, 0) }
        addView(message)
        addView(primaryButton("Dodaj za $year. letnik") {
            if (title.text.isBlank()) { message.text = "Vpiši ime dogodka."; title.requestFocus(); return@primaryButton }
            message.text = "Shranjujem …"
            val body = JSONObject().put("title", title.text.toString().trim()).put("date", date.toString()).put("start", start).put("end", end()).put("room", room.text.toString().trim()).put("programme", year)
            val password = adminToken()
            executor.execute {
                val result = runCatching { repo.adminAddEvent(password, body) }
                runOnUiThread {
                    result.onSuccess { event ->
                        dialog.dismiss(); toast("Dogodek je dodan za ves $year. letnik.")
                        val eventWeek = LocalDate.parse(event.date).with(DayOfWeek.MONDAY)
                        if (eventWeek != week) { week = eventWeek; loadWeek(true, eventWeek > week) } else { weekData = weekData.copy(events = (weekData.events.filter { it.id != event.id } + event).sortedWith(compareBy({ it.date }, { it.start }))); updateHeader(); render(animate = false) }
                    }.onFailure { message.text = friendly(it) }
                }
            }
        }, LinearLayout.LayoutParams(MATCH, dp(52)).apply { topMargin = dp(10) })
        title.requestFocus()
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE or WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    }

    /** A row of wrap-width chips (for options of uneven length), selection styled like [segmented]. */
    private fun choices(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) = LinearLayout(this).apply {
        options.forEach { (value, text) ->
            addView(chip(text, value == selected) { onSelect(value) }.apply { tag = value; setPadding(dp(14), 0, dp(14), 0) }, LinearLayout.LayoutParams(WRAP, dp(42)).apply { rightMargin = dp(6) })
        }
    }

    private fun pickTime(current: String, onPicked: (String) -> Unit) {
        val time = runCatching { LocalTime.parse(current) }.getOrDefault(LocalTime.NOON)
        TimePickerDialog(this, { _, h, m -> onPicked("${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}") }, time.hour, time.minute, true).show()
    }

    /** Bottom sheet with the app's rounded surface, scrollable for tall content and padded above the navigation bar. */
    private fun sheet(build: LinearLayout.(BottomSheetDialog) -> Unit) {
        val dialog = BottomSheetDialog(this)
        // Set before build() so a sheet can add flags of its own (the composer asks for the keyboard).
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(12), dp(24), dp(28))
            addView(View(this@MainActivity).apply { background = rounded(color(R.color.sheet_handle), color(R.color.sheet_handle), 3) }, LinearLayout.LayoutParams(dp(36), dp(4)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(22) })
            build(dialog)
        }
        val container = NestedScrollView(this).apply {
            background = GradientDrawable().apply { setColor(color(R.color.canvas)); val r = dp(26).toFloat(); cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f) }
            addView(body)
        }
        ViewCompat.setOnApplyWindowInsetsListener(container) { _, insets ->
            val bottom = insets.getInsets(WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.ime()).bottom
            body.setPadding(dp(24), dp(12), dp(24), dp(28) + bottom); insets
        }
        dialog.setContentView(container)
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        dialog.behavior.skipCollapsed = true
        dialog.show()
    }

    private fun segmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) = LinearLayout(this).apply {
        tag = selected
        options.forEachIndexed { index, (value, text) ->
            addView(chip(text, value == selected) { refreshSegmented(this, value); onSelect(value) }.apply { tag = value }, LinearLayout.LayoutParams(0, dp(44)).apply { weight = 1f; if (index != options.lastIndex) rightMargin = dp(6) })
        }
    }

    private fun refreshSegmented(group: LinearLayout, value: String) = repeat(group.childCount) { styleChip(group.getChildAt(it) as TextView, group.getChildAt(it).tag == value, animate = true) }

    // ---- Motion ----

    /** Replaces the page inside [host]: the old one drifts out and fades while the new one springs in from the side it came from. */
    private fun slideIn(host: ViewGroup, view: View, animate: Boolean, forward: Boolean) {
        // A page still leaving from a previous quick swipe is dropped so pages never pile up.
        (0 until host.childCount).map { host.getChildAt(it) }.filter { it.getTag(R.id.leaving) == true }.forEach { it.animate().cancel(); host.removeView(it) }
        val old = if (host.childCount > 0) host.getChildAt(host.childCount - 1) else null
        val distance = host.width.coerceAtLeast(contentWidth()).toFloat()
        val direction = if (forward) 1 else -1
        host.addView(view, FrameLayout.LayoutParams(MATCH, WRAP))
        if (!animate || old == null) { old?.let { host.removeView(it) }; if (animate) { view.alpha = 0f; view.animate().alpha(1f).setDuration(260L).setInterpolator(EMPHASIZED).start() }; return }
        old.setTag(R.id.leaving, true)
        old.animate().translationX(-direction * distance * 0.28f).alpha(0f).scaleX(.97f).scaleY(.97f).setDuration(240L).setInterpolator(EMPHASIZED_ACCELERATE).withEndAction { host.removeView(old) }.start()
        view.alpha = 0f; view.translationX = direction * distance * 0.38f
        spring(view, DynamicAnimation.TRANSLATION_X, 0f, 340f, 0.86f)
        view.animate().alpha(1f).setStartDelay(40L).setDuration(260L).setInterpolator(EMPHASIZED).start()
    }

    /** Rolls a label to new text: the old value slides out and the new one in, in the direction of travel. */
    private fun roll(view: TextView, text: String, forward: Boolean?) {
        if (view.text.toString() == text) return
        if (forward == null || view.text.isEmpty()) { view.text = text; return }
        val distance = dp(10).toFloat() * (if (forward) -1 else 1)
        view.animate().cancel()
        view.animate().translationX(distance).alpha(0f).setDuration(110L).setInterpolator(EMPHASIZED_ACCELERATE).withEndAction {
            view.text = text; view.translationX = -distance
            view.animate().translationX(0f).alpha(1f).setDuration(260L).setInterpolator(EMPHASIZED).start()
        }.start()
    }

    /** Switching views is not movement in time, so it fades through (out, then in with a slight zoom) instead of sliding. */
    private fun fadeThrough(host: ViewGroup, view: View) {
        (0 until host.childCount).map { host.getChildAt(it) }.forEach { old -> old.animate().cancel(); old.setTag(R.id.leaving, true); old.animate().alpha(0f).setDuration(90L).withEndAction { host.removeView(old) }.start() }
        host.addView(view, FrameLayout.LayoutParams(MATCH, WRAP))
        view.alpha = 0f; view.scaleX = .965f; view.scaleY = .965f; view.pivotY = 0f
        view.animate().alpha(1f).scaleX(1f).scaleY(1f).setStartDelay(90L).setDuration(300L).setInterpolator(EMPHASIZED).start()
    }

    private fun spring(view: View, property: DynamicAnimation.ViewProperty, target: Float, stiffness: Float, damping: Float) =
        SpringAnimation(view, property, target).apply { spring.stiffness = stiffness; spring.dampingRatio = damping; start() }

    /** Pressed views sink slightly and spring back — a small cue that the tap was felt. */
    private fun pressable(view: View) {
        view.stateListAnimator = StateListAnimator().apply {
            addState(intArrayOf(android.R.attr.state_pressed), AnimatorSet().apply {
                playTogether(ObjectAnimator.ofFloat(view, View.SCALE_X, .965f), ObjectAnimator.ofFloat(view, View.SCALE_Y, .965f)); duration = 110L; interpolator = EMPHASIZED
            })
            addState(intArrayOf(), AnimatorSet().apply {
                playTogether(ObjectAnimator.ofFloat(view, View.SCALE_X, 1f), ObjectAnimator.ofFloat(view, View.SCALE_Y, 1f)); duration = 260L; interpolator = android.view.animation.OvershootInterpolator(2.2f)
            })
        }
    }

    private fun tick() = content.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)

    private var skeletonPulse: ObjectAnimator? = null
    private fun pulse(view: View, on: Boolean) {
        if (!on) { skeletonPulse?.cancel(); skeletonPulse = null; view.alpha = 1f; return }
        if (skeletonPulse != null) return
        skeletonPulse = ObjectAnimator.ofFloat(view, View.ALPHA, 1f, .45f).apply { duration = 850L; repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE; interpolator = android.view.animation.AccelerateDecelerateInterpolator(); start() }
    }

    // The "now" dot breathes so the current time reads as live; the loop stops when the grid is replaced.
    private fun breathe(view: View) {
        val loop = AnimatorSet().apply {
            playTogether(
                ObjectAnimator.ofFloat(view, View.SCALE_X, 1f, 1.7f).apply { repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE },
                ObjectAnimator.ofFloat(view, View.SCALE_Y, 1f, 1.7f).apply { repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE },
                ObjectAnimator.ofFloat(view, View.ALPHA, 1f, .55f).apply { repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE },
            )
            duration = 1100L; interpolator = android.view.animation.AccelerateDecelerateInterpolator()
        }
        view.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) { loop.start() }
            override fun onViewDetachedFromWindow(v: View) { loop.cancel() }
        })
    }

    // ---- Small view helpers ----

    private data class Palette(val fill: Int, val edge: Int, val text: Int, val tag: Int)

    private fun palette(lesson: Lesson) = when (lesson.source) {
        "FRI" -> Palette(color(R.color.fri_fill), color(R.color.fri_edge), color(R.color.fri_text), color(R.color.fri_tag))
        "FMF" -> Palette(color(R.color.fmf_fill), color(R.color.fmf_edge), color(R.color.fmf_text), color(R.color.fmf_tag))
        else -> Palette(color(R.color.today_fill), color(R.color.surface_edge), color(R.color.today_text), color(R.color.surface))
    }

    private fun faculty(source: String) = when (source) { "FRI" -> "Računalništvo in informatika"; "FMF" -> "Matematika in fizika"; else -> "Skupni dogodek" }

    private fun typeName(type: String) = when (type.uppercase(Locale.ROOT)) {
        "P" -> "Predavanje"; "AV" -> "Avditorne vaje"; "LV" -> "Laboratorijske vaje"; "V" -> "Vaje"; "S", "SEM" -> "Seminar"; else -> type
    }

    // "pon." → "Pon": the locale's abbreviation dot only adds noise on a button.
    private fun weekday(day: LocalDate) = day.format(weekdayShort).trimEnd('.').replaceFirstChar { it.titlecase(slovene) }

    private fun dayChip(day: LocalDate, selected: Boolean, onClick: () -> Unit) = chip("${weekday(day)}\n${day.dayOfMonth}", selected, onClick).apply {
        setLines(2); textSize = 12f
        styleDayChip(this, day, selected)
    }

    private fun chip(text: String, selected: Boolean, onClick: () -> Unit) = TextView(this).apply {
        this.text = text; gravity = Gravity.CENTER; textSize = 13f
        setTypeface(Typeface.create("sans-serif", Typeface.BOLD))
        isClickable = true; isFocusable = true; setOnClickListener { onClick() }
        styleChip(this, selected)
        pressable(this)
    }

    private fun styleChip(view: TextView, selected: Boolean, animate: Boolean = false) =
        paintChip(view, color(if (selected) R.color.accent else R.color.surface), color(if (selected) R.color.accent else R.color.surface_edge), color(if (selected) R.color.on_accent else R.color.muted), 13, animate)

    private fun styleDayChip(view: TextView, day: LocalDate, selected: Boolean, animate: Boolean = false) = when {
        selected && (view.parent as? View)?.getTag(R.id.pill) != null -> paintChip(view, Color.TRANSPARENT, Color.TRANSPARENT, color(R.color.on_accent), 12, animate)
        selected -> styleChip(view, true, animate)
        day == LocalDate.now() -> paintChip(view, color(R.color.today_fill), color(R.color.today_fill), color(R.color.today_text), 12, animate)
        else -> styleChip(view, false, animate)
    }

    // Selection changes cross-fade their colours instead of snapping, which is most of what makes a tab bar feel smooth.
    private fun paintChip(view: TextView, fill: Int, stroke: Int, text: Int, radius: Int, animate: Boolean) {
        val current = view.background as? GradientDrawable
        val from = view.getTag(R.id.chip_colors) as? IntArray
        view.setTag(R.id.chip_colors, intArrayOf(fill, stroke, text))
        if (!animate || current == null || from == null) { view.setTextColor(text); view.background = rounded(fill, stroke, radius); return }
        val evaluator = ArgbEvaluator()
        ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 220L; interpolator = EMPHASIZED
            addUpdateListener { a ->
                val t = a.animatedFraction
                current.setColor(evaluator.evaluate(t, from[0], fill) as Int)
                current.setStroke(dp(1), evaluator.evaluate(t, from[1], stroke) as Int)
                view.setTextColor(evaluator.evaluate(t, from[2], text) as Int)
            }
        }.start()
    }

    private fun primaryButton(text: String, onClick: () -> Unit) = TextView(this).apply {
        this.text = text; gravity = Gravity.CENTER; textSize = 15f; setTypeface(Typeface.create("sans-serif", Typeface.BOLD))
        setTextColor(color(R.color.on_accent)); setBackgroundResource(R.drawable.today_button); isClickable = true; isFocusable = true; setOnClickListener { onClick() }
        pressable(this)
    }

    private fun secondaryButton(text: String, onClick: () -> Unit) = TextView(this).apply {
        this.text = text; gravity = Gravity.CENTER; textSize = 14f; setTypeface(Typeface.create("sans-serif", Typeface.BOLD))
        setTextColor(color(R.color.ink)); setBackgroundResource(R.drawable.control_surface); isClickable = true; isFocusable = true; setOnClickListener { onClick() }
        pressable(this)
    }

    private fun input(hint: String, value: String, type: Int) = EditText(this).apply {
        this.hint = hint; setText(value); inputType = type; textSize = 15f; setSingleLine()
        typeface = Typeface.create("sans-serif", Typeface.NORMAL) // password inputs otherwise switch to monospace
        // setSingleLine() swaps in a plain single-line transformation, which un-masks password fields; put masking back.
        if (type and InputType.TYPE_MASK_VARIATION == InputType.TYPE_TEXT_VARIATION_PASSWORD) transformationMethod = android.text.method.PasswordTransformationMethod.getInstance()
        setTextColor(color(R.color.ink)); setHintTextColor(color(R.color.muted)); setBackgroundResource(R.drawable.input_surface); setPadding(dp(14), 0, dp(14), 0)
    }

    private fun kicker(text: String) = label(text, 10f, color(R.color.muted), Typeface.BOLD).apply { letterSpacing = 0.1f }
    private fun section(text: String) = kicker(text).apply { setPadding(0, dp(22), 0, dp(8)) }

    private fun iconLine(icon: Int, text: String) = label(text, 13f, color(R.color.muted), Typeface.NORMAL).apply {
        val drawable = tinted(icon, R.color.muted)?.apply { setBounds(0, 0, dp(14), dp(14)) }
        setCompoundDrawablesRelative(drawable, null, null, null); compoundDrawablePadding = dp(5); gravity = Gravity.CENTER_VERTICAL
    }

    private fun strike(view: TextView, on: Boolean) { view.paintFlags = if (on) view.paintFlags or android.graphics.Paint.STRIKE_THRU_TEXT_FLAG else view.paintFlags and android.graphics.Paint.STRIKE_THRU_TEXT_FLAG.inv() }
    private fun tinted(icon: Int, tint: Int) = ContextCompat.getDrawable(this, icon)?.mutate()?.apply { setTint(color(tint)) }
    private fun label(text: String, size: Float, textColor: Int, style: Int) = TextView(this).apply { this.text = text; setTextColor(textColor); textSize = size; setTypeface(Typeface.create("sans-serif", style)) }
    private fun tag(text: String, fill: Int, textColor: Int) = label(text, 10f, textColor, Typeface.BOLD).apply { gravity = Gravity.CENTER; letterSpacing = 0.08f; background = rounded(fill, fill, 8) }
    private fun rounded(fill: Int, stroke: Int, radius: Int, strokeWidth: Int = 1) = GradientDrawable().apply { shape = GradientDrawable.RECTANGLE; cornerRadius = dp(radius).toFloat(); setColor(fill); setStroke(dp(strokeWidth), stroke) }
    private fun selectableForeground(): android.graphics.drawable.Drawable? { val value = TypedValue(); theme.resolveAttribute(android.R.attr.selectableItemBackground, value, true); return ContextCompat.getDrawable(this, value.resourceId) }
    private fun color(id: Int) = ContextCompat.getColor(this, id)
    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()
    private fun contentWidth() = (content.width.takeIf { it > 0 } ?: (resources.displayMetrics.widthPixels - dp(40)))
    private fun toast(text: String) = android.widget.Toast.makeText(this, text, android.widget.Toast.LENGTH_SHORT).show()
    private fun open(url: String) = try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: ActivityNotFoundException) { toast("Povezave ni mogoče odpreti.") }

    private fun buildDate() = runCatching { LocalDate.parse(BuildConfig.BUILD_DATE).format(DateTimeFormatter.ofPattern("d. M. yyyy")) }.getOrDefault(BuildConfig.BUILD_DATE)
    private fun minutes(time: String): Int { val pieces = time.split(':').mapNotNull { it.toIntOrNull() }; return pieces.getOrElse(0) { 0 } * 60 + pieces.getOrElse(1) { 0 } }
    private fun nowMinutes() = LocalTime.now().let { it.hour * 60 + it.minute }
    private fun isNow(lesson: Lesson) = lesson.date == LocalDate.now().toString() && nowMinutes() in minutes(lesson.start) until minutes(lesson.end)
    private fun isPast(lesson: Lesson) = lesson.date < LocalDate.now().toString() || (lesson.date == LocalDate.now().toString() && nowMinutes() >= minutes(lesson.end))
    // On Saturday and Sunday the useful week is the coming one, so "today" means next Monday's week.
    /** Mon–Fri, plus Saturday/Sunday only when they hold an event (e.g. an admin-added weekend exam). */
    private fun daysOf(week: LocalDate, items: List<Lesson>) = (0..6L).map { week.plusDays(it) }.filter { day -> day.dayOfWeek.value <= 5 || items.any { it.date == day.toString() } }

    private fun thisMonday() = LocalDate.now().let { if (it.dayOfWeek.value >= 6) it.with(java.time.temporal.TemporalAdjusters.next(DayOfWeek.MONDAY)) else it.with(DayOfWeek.MONDAY) }
    private fun todayIndex() = LocalDate.now().dayOfWeek.value.let { if (it >= 6) 0 else it - 1 }
    // A week that spans two months opens the month today is in, rather than the month its Monday falls in.
    private fun monthFor(week: LocalDate) = LocalDate.now().let { today -> if (!today.isBefore(week.minusDays(2)) && today.isBefore(week.plusDays(7))) today else week }.withDayOfMonth(1)

    private fun isDark() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    private fun nightModeFor(theme: String) = when (theme) { "light" -> AppCompatDelegate.MODE_NIGHT_NO; "dark" -> AppCompatDelegate.MODE_NIGHT_YES; else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM }
    private fun applyTheme(theme: String) { prefs.edit().putString("theme", theme).apply(); AppCompatDelegate.setDefaultNightMode(nightModeFor(theme)) }

    private fun newer(remote: String, local: String): Boolean { val a = remote.split('.').map { it.toIntOrNull() ?: 0 }; val b = local.split('.').map { it.toIntOrNull() ?: 0 }; for (index in 0 until maxOf(a.size, b.size)) { val x = a.getOrElse(index) { 0 }; val y = b.getOrElse(index) { 0 }; if (x != y) return x > y }; return false }

    private data class Release(val version: String, val apkUrl: String, val page: String, val notes: List<String>)

    private fun checkRelease(manual: Boolean = false) = background.execute {
        val release = runCatching {
            val json = JSONObject(URL("${BuildConfig.WEB_APP_URL.trimEnd('/')}/api/release").readText())
            val notes = json.optJSONArray("androidNotes")?.let { list -> (0 until list.length()).map { list.getString(it) } } ?: emptyList()
            Release(json.optString("androidVersion"), json.optString("androidApkUrl"), releasePage(json.optString("androidReleaseUrl")), notes)
        }.getOrNull()
        runOnUiThread {
            if (isDestroyed) return@runOnUiThread
            when {
                release != null && newer(release.version, BuildConfig.VERSION_NAME) -> showUpdate(release)
                manual -> toast(if (release == null) "Posodobitev ni mogoče preveriti." else "Imaš najnovejšo različico (${BuildConfig.VERSION_NAME}).")
            }
        }
    }

    // An update waiting for the "install unknown apps" permission; resumed in onResume once it is granted.
    private var pendingUpdate: (() -> Unit)? = null

    /** The update sheet: what's new, then download with progress and hand the APK to Android's installer. */
    private fun showUpdate(release: Release) = sheet { dialog ->
        addView(FrameLayout(this@MainActivity).apply {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color(R.color.accent)) }
            addView(android.widget.ImageView(this@MainActivity).apply { setImageDrawable(tinted(R.drawable.ic_download, R.color.on_accent)) }, FrameLayout.LayoutParams(dp(26), dp(26), Gravity.CENTER))
        }, LinearLayout.LayoutParams(dp(56), dp(56)))
        addView(kicker("NOVA RAZLIČICA").apply { setPadding(0, dp(18), 0, 0) })
        addView(label("IŠRM ${release.version}", 28f, color(R.color.ink), Typeface.BOLD).apply { setPadding(0, dp(4), 0, 0) })
        addView(label("Imaš ${BuildConfig.VERSION_NAME}. Posodobitev se namesti kar tukaj, tvoji podatki ostanejo.", 14f, color(R.color.muted), Typeface.NORMAL).apply { setPadding(0, dp(6), 0, 0); setLineSpacing(0f, 1.15f) })
        if (release.notes.isNotEmpty()) {
            addView(section("NOVO"))
            release.notes.forEach { note -> addView(label("•  $note", 15f, color(R.color.ink), Typeface.NORMAL).apply { setPadding(0, dp(3), 0, dp(3)) }) }
        }
        val track = FrameLayout(this@MainActivity).apply { background = rounded(color(R.color.surface_edge), color(R.color.surface_edge), 4); visibility = View.GONE }
        val fill = View(this@MainActivity).apply { background = rounded(color(R.color.accent), color(R.color.accent), 4); pivotX = 0f; scaleX = 0f }
        track.addView(fill, FrameLayout.LayoutParams(MATCH, MATCH))
        addView(track, LinearLayout.LayoutParams(MATCH, dp(8)).apply { topMargin = dp(22) })
        val status = label("", 13f, color(R.color.muted), Typeface.BOLD).apply { setPadding(0, dp(8), 0, 0) }
        addView(status)
        lateinit var action: TextView
        val later = secondaryButton("Kasneje") { dialog.dismiss() }

        fun install(apk: java.io.File) {
            status.text = "Nameščam … Android te lahko prosi za potrditev. Po posodobitvi aplikacijo odpri znova."
            runCatching { Updater.install(this@MainActivity, apk) }.onFailure { status.text = "Namestitev ni uspela: ${it.message}"; action.isEnabled = true; action.alpha = 1f }
        }
        fun start() {
            if (release.apkUrl.isBlank()) { open(release.page); dialog.dismiss(); return }
            if (android.os.Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
                status.text = "Najprej enkrat dovoli, da IŠRM namešča svoje posodobitve, nato se vrni sem."
                action.text = "Odpri nastavitve"
                action.setOnClickListener {
                    pendingUpdate = { start() }
                    startActivity(Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
                }
                return
            }
            action.isEnabled = false; action.alpha = .5f; action.text = "Posodabljam …"; later.visibility = View.GONE
            track.visibility = View.VISIBLE; status.text = "Prenašam …"
            this@MainActivity.background.execute {
                val result = runCatching {
                    Updater.download(this@MainActivity, release.apkUrl) { percent ->
                        runOnUiThread { if (percent >= 0) { fill.animate().scaleX(percent / 100f).setDuration(120L).start(); status.text = "Prenašam … $percent %" } }
                    }
                }
                runOnUiThread {
                    result.onSuccess { fill.animate().scaleX(1f).setDuration(120L).start(); install(it) }
                        .onFailure { status.text = "Prenos ni uspel. Preveri povezavo in poskusi znova."; action.text = "Poskusi znova"; action.isEnabled = true; action.alpha = 1f; action.setOnClickListener { start() } }
                }
            }
        }
        action = primaryButton("Posodobi zdaj") { start() }
        addView(action, LinearLayout.LayoutParams(MATCH, dp(54)).apply { topMargin = dp(14) })
        addView(later, LinearLayout.LayoutParams(MATCH, dp(48)).apply { topMargin = dp(8) })
        // For anyone who prefers the usual route: the browser downloads the APK and Android installs it from there.
        addView(manualDownloadLink(), LinearLayout.LayoutParams(MATCH, dp(44)).apply { topMargin = dp(4) })
    }

    /** Opens the stable /download link (always the newest APK) in the browser; long-press copies it to share. */
    private fun manualDownloadLink(text: String = "Prenesi ročno (APK)") = label(text, 14f, color(R.color.accent), Typeface.BOLD).apply {
        val link = "${BuildConfig.WEB_APP_URL.trimEnd('/')}/download"
        gravity = Gravity.CENTER; isClickable = true; isFocusable = true; foreground = selectableForeground()
        contentDescription = "$text: $link"
        setOnClickListener { open(link) }
        setOnLongClickListener {
            (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("IŠRM APK", link)); toast("Povezava kopirana: $link"); true
        }
    }

    private fun releasePage(configured: String): String { val base = BuildConfig.WEB_APP_URL.trimEnd('/'); return when { configured.startsWith("https://") -> configured; configured.startsWith("/") -> "$base$configured"; else -> "$base/android" } }
    override fun onDestroy() { executor.shutdownNow(); background.shutdownNow(); super.onDestroy() }

    private companion object {
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        // Process-wide so a theme switch (which recreates the activity) does not ask about the same update twice.
        var releaseChecked = false
        const val LIVE_POLL_MS = 20_000L
        // Material 3 "emphasized" curves: quick start, long gentle settle.
        val EMPHASIZED = PathInterpolator(0.2f, 0f, 0f, 1f)
        val EMPHASIZED_ACCELERATE = PathInterpolator(0.3f, 0f, 0.8f, 0.15f)
    }
}
