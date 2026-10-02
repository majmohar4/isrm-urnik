package eu.majmohar.isrm

import android.content.Context

data class WidgetConfig(val mode: String, val programme: String, val student: String, val baseUrl: String)

object WidgetPrefs {
    private fun prefs(context: Context) = context.getSharedPreferences("widget-config", Context.MODE_PRIVATE)
    fun get(context: Context, id: Int) = WidgetConfig(
        prefs(context).getString("mode-$id", "next") ?: "next",
        prefs(context).getString("programme-$id", "1") ?: "1",
        prefs(context).getString("student-$id", "") ?: "",
        prefs(context).getString("url-$id", BuildConfig.WEB_APP_URL) ?: BuildConfig.WEB_APP_URL,
    )
    fun put(context: Context, id: Int, config: WidgetConfig) = prefs(context).edit()
        .putString("mode-$id", config.mode).putString("programme-$id", config.programme)
        .putString("student-$id", config.student).putString("url-$id", config.baseUrl.trimEnd('/')).apply()
    fun remove(context: Context, id: Int) = prefs(context).edit().remove("mode-$id").remove("programme-$id").remove("student-$id").remove("url-$id").apply()
}
