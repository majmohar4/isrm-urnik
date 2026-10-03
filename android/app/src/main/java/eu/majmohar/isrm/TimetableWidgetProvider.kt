package eu.majmohar.isrm

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import androidx.work.CoroutineWorker
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalDateTime
import java.util.concurrent.TimeUnit

object WidgetRefresh {
    private const val PERIODIC = "isrm-widget-periodic"
    private val networkRequired = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
    fun schedule(context: Context) = WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, PeriodicWorkRequestBuilder<WidgetWorker>(6, TimeUnit.HOURS).setConstraints(networkRequired).build())
    fun now(context: Context) = WorkManager.getInstance(context).enqueue(OneTimeWorkRequestBuilder<WidgetWorker>().build())
    fun cancel(context: Context) = WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
}

class TimetableWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) { WidgetRefresh.schedule(context); WidgetRefresh.now(context) }
    override fun onReceive(context: Context, intent: Intent) { super.onReceive(context, intent); if (intent.action == ACTION_REFRESH) WidgetRefresh.now(context) }
    override fun onDeleted(context: Context, ids: IntArray) { ids.forEach { WidgetPrefs.remove(context, it) }; if (AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, TimetableWidgetProvider::class.java)).isEmpty()) WidgetRefresh.cancel(context) }
    override fun onDisabled(context: Context) { WidgetRefresh.cancel(context) }
    companion object { const val ACTION_REFRESH = "eu.majmohar.isrm.REFRESH_WIDGET" }
}

class WidgetWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val manager = AppWidgetManager.getInstance(applicationContext)
        manager.getAppWidgetIds(ComponentName(applicationContext, TimetableWidgetProvider::class.java)).forEach { id -> runCatching { render(id, WidgetPrefs.get(applicationContext, id)) }.onFailure { renderError(id) } }
        Result.success()
    }

    private fun render(id: Int, config: WidgetConfig) {
        val events = TimetableRepository(applicationContext).refresh(LocalDate.now().with(DayOfWeek.MONDAY), config.programme, config.student)
        val today = LocalDate.now().toString()
        val now = LocalDateTime.now()
        val next = events.firstOrNull { it.date >= today && LocalDateTime.parse("${it.date}T${it.end}") > now }
        val views = baseViews(id, config)
        if (config.mode == "day") renderDay(views, events.filter { it.date == today }) else renderNext(views, next)
        AppWidgetManager.getInstance(applicationContext).updateAppWidget(id, views)
    }

    private fun baseViews(id: Int, config: WidgetConfig) = RemoteViews(applicationContext.packageName, R.layout.widget_timetable).apply {
        val open = PendingIntent.getActivity(applicationContext, id, Intent(applicationContext, MainActivity::class.java).setData(android.net.Uri.parse("isrm://widget/$id")), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val refresh = PendingIntent.getBroadcast(applicationContext, id + 10_000, Intent(applicationContext, TimetableWidgetProvider::class.java).setAction(TimetableWidgetProvider.ACTION_REFRESH), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        setOnClickPendingIntent(R.id.widget_root, open)
        setOnClickPendingIntent(R.id.widget_refresh, refresh)
        setViewVisibility(R.id.widget_next_content, View.GONE)
        setViewVisibility(R.id.widget_day_content, View.GONE)
    }

    private fun renderNext(views: RemoteViews, next: Lesson?) = views.apply {
        setViewVisibility(R.id.widget_next_content, View.VISIBLE)
        setTextViewText(R.id.widget_title, "NASLEDNJA URA · IŠRM")
        if (next == null) {
            setTextViewText(R.id.widget_time, "—")
            setTextViewText(R.id.widget_primary, "Ni naslednje obveznosti")
            setTextViewText(R.id.widget_secondary, "Urnik se samodejno osveži")
        } else {
            setTextViewText(R.id.widget_time, next.start)
            setTextViewText(R.id.widget_primary, next.title)
            setTextViewText(R.id.widget_secondary, "${next.room.ifBlank { "Lokacija ni znana" }} · ${next.source}")
        }
    }

    private fun renderDay(views: RemoteViews, today: List<Lesson>) = views.apply {
        setViewVisibility(R.id.widget_day_content, View.VISIBLE)
        setTextViewText(R.id.widget_title, "DANES · IŠRM")
        val slots = intArrayOf(R.id.widget_day_event_1, R.id.widget_day_event_2, R.id.widget_day_event_3)
        today.take(3).forEachIndexed { index, event -> setViewVisibility(slots[index], View.VISIBLE); setTextViewText(slots[index], "${event.start}  ${event.title} · ${event.room.ifBlank { event.source }}") }
        for (index in today.take(3).size until slots.size) setViewVisibility(slots[index], View.GONE)
        setTextViewText(R.id.widget_day_footer, when {
            today.isEmpty() -> "Danes ni obveznosti"
            today.size > 3 -> "Še ${today.size - 3} ${if (today.size == 4) "obveznost" else "obveznosti"} · tapni za urnik"
            else -> "${today.size} ${if (today.size == 1) "obveznost" else "obveznosti"} danes · tapni za urnik"
        })
    }

    private fun renderError(id: Int) {
        val config = WidgetPrefs.get(applicationContext, id)
        val cached = TimetableRepository(applicationContext).cached(LocalDate.now().with(DayOfWeek.MONDAY), config.programme, config.student)
        val views = baseViews(id, config)
        renderNext(views, cached.firstOrNull { it.date >= LocalDate.now().toString() })
        views.setTextViewText(R.id.widget_title, "IŠRM · SHRANJEN URNIK")
        if (cached.isEmpty()) {
            views.setTextViewText(R.id.widget_primary, "Urnika trenutno ni mogoče naložiti")
            views.setTextViewText(R.id.widget_secondary, "Tapni za ponovni poskus")
        }
        AppWidgetManager.getInstance(applicationContext).updateAppWidget(id, views)
    }
}
