package eu.majmohar.isrm

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
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
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit

object WidgetRefresh {
    private const val PERIODIC = "isrm-widget-periodic"
    private val networkRequired = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
    fun schedule(context: Context) { WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, PeriodicWorkRequestBuilder<WidgetWorker>(6, TimeUnit.HOURS).setConstraints(networkRequired).build()) }
    fun now(context: Context) { WorkManager.getInstance(context).enqueue(OneTimeWorkRequestBuilder<WidgetWorker>().build()) }
    fun cancel(context: Context) { WorkManager.getInstance(context).cancelUniqueWork(PERIODIC) }
}

class TimetableWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) { WidgetRefresh.schedule(context); WidgetRefresh.now(context) }
    override fun onReceive(context: Context, intent: Intent) { super.onReceive(context, intent); if (intent.action == "eu.majmohar.isrm.REFRESH_WIDGET") WidgetRefresh.now(context) }
    override fun onDeleted(context: Context, ids: IntArray) { ids.forEach { WidgetPrefs.remove(context, it) }; if (AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, TimetableWidgetProvider::class.java)).isEmpty()) WidgetRefresh.cancel(context) }
    override fun onDisabled(context: Context) { WidgetRefresh.cancel(context) }
}

class WidgetWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val manager = AppWidgetManager.getInstance(applicationContext)
        val ids = manager.getAppWidgetIds(ComponentName(applicationContext, TimetableWidgetProvider::class.java))
        ids.forEach { id -> runCatching { render(id, WidgetPrefs.get(applicationContext, id)) }.onFailure { renderError(id) } }
        Result.success()
    }
    private fun render(id: Int, config: WidgetConfig) {
        val monday = LocalDate.now().with(DayOfWeek.MONDAY)
        val events = TimetableRepository(applicationContext).refresh(monday, config.programme, config.student)
        val today = LocalDate.now().toString()
        val now = LocalDateTime.now()
        val selected = events.filter { it.date >= today }
        val next = selected.firstOrNull { event -> LocalDateTime.parse("${event.date}T${event.end}") > now }
        val views = RemoteViews(applicationContext.packageName, R.layout.widget_timetable)
        views.setTextViewText(R.id.widget_title, if (config.mode == "day") "DANES · IŠRM" else "NASLEDNJA URA · IŠRM")
        if (config.mode == "day") {
            val todayEvents = selected.filter { it.date == today }.take(5)
            views.setTextViewText(R.id.widget_primary, todayEvents.joinToString("\n") { "${it.start}  ${it.title} · ${it.room}" }.ifBlank { "Danes ni obveznosti" })
            views.setTextViewText(R.id.widget_secondary, "${todayEvents.size} prikazanih obveznosti")
        } else if (next != null) {
            views.setTextViewText(R.id.widget_primary, "${next.start}–${next.end}  ${next.title}")
            views.setTextViewText(R.id.widget_secondary, "${next.room.ifBlank { "Lokacija ni znana" }} · ${next.source}")
        } else { views.setTextViewText(R.id.widget_primary, "Ni naslednje obveznosti"); views.setTextViewText(R.id.widget_secondary, "Urnik bo samodejno osvežen") }
        val open = PendingIntent.getActivity(applicationContext, id, Intent(applicationContext, MainActivity::class.java).setData(android.net.Uri.parse(config.baseUrl)), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val refresh = PendingIntent.getBroadcast(applicationContext, id + 10_000, Intent(applicationContext, TimetableWidgetProvider::class.java).setAction("eu.majmohar.isrm.REFRESH_WIDGET"), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        views.setOnClickPendingIntent(R.id.widget_root, open); views.setOnClickPendingIntent(R.id.widget_refresh, refresh)
        AppWidgetManager.getInstance(applicationContext).updateAppWidget(id, views)
    }
    private fun renderError(id: Int) { val config=WidgetPrefs.get(applicationContext,id);val cached=TimetableRepository(applicationContext).cached(LocalDate.now().with(DayOfWeek.MONDAY),config.programme,config.student);val v = RemoteViews(applicationContext.packageName, R.layout.widget_timetable); v.setTextViewText(R.id.widget_primary, cached.firstOrNull()?.let{"${it.start}  ${it.title}"} ?: "Urnika trenutno ni mogoče naložiti"); v.setTextViewText(R.id.widget_secondary, if(cached.isEmpty()) "Dotakni se za ponovni poskus" else "Prikazan je shranjen urnik"); val refresh = PendingIntent.getBroadcast(applicationContext, id + 10_000, Intent(applicationContext, TimetableWidgetProvider::class.java).setAction("eu.majmohar.isrm.REFRESH_WIDGET"), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE); v.setOnClickPendingIntent(R.id.widget_root, refresh); AppWidgetManager.getInstance(applicationContext).updateAppWidget(id, v) }
}
