package eu.majmohar.isrm

import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import kotlin.math.roundToInt

/**
 * Failsafe for when the IŠRM server is down: reads the FRI and FMF timetable pages directly and parses them with the
 * same rules as the server (`parseFri` / `parseFmf` in server.mjs). Keep the two in step when either page changes.
 */
object DirectSource {
    data class Urls(val fri: String, val fmf: String)

    // Used until the server has told the app its current links (/api/sources), e.g. on a fresh install while it is down.
    val DEFAULTS = mapOf(
        "1" to Urls("https://urnik.fri.uni-lj.si/timetable/fri-2026_2027-zimski/allocations?group=64611", "https://urnik.fmf.uni-lj.si/layer_one/42/"),
        "2" to Urls("https://urnik.fri.uni-lj.si/timetable/fri-2026_2027-zimski/allocations?group=64538", "https://urnik.fmf.uni-lj.si/layer_one/49/"),
        "3" to Urls("https://urnik.fri.uni-lj.si/timetable/fri-2026_2027-zimski/allocations?group=64558", "https://urnik.fmf.uni-lj.si/layer_one/55/"),
    )

    private val ci = setOf(RegexOption.IGNORE_CASE)
    private val dayIndex = mapOf("MON" to 0, "TUE" to 1, "WED" to 2, "THU" to 3, "FRI" to 4)

    // The FRI page is the whole semester's recurring timetable, so one download serves every week for a while.
    private val friPages = mutableMapOf<String, Pair<Long, String>>()
    private const val FRI_PAGE_TTL_MS = 30 * 60_000L

    fun fetch(url: String): String {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000; readTimeout = 15_000
            setRequestProperty("User-Agent", "ISRM-Android/${BuildConfig.VERSION_NAME} (timetable failsafe; low-frequency)")
        }
        val status = connection.responseCode
        if (status !in 200..299) throw ApiException("Vir ni dosegljiv (HTTP $status).")
        return connection.inputStream.bufferedReader().use { it.readText() }
    }

    fun friPage(url: String): String = synchronized(friPages) {
        friPages[url]?.takeIf { System.currentTimeMillis() - it.first < FRI_PAGE_TTL_MS }?.second
    } ?: fetch(url).also { synchronized(friPages) { friPages[url] = System.currentTimeMillis() to it } }

    /** The personal FRI page is the group page with `student=` instead of the group parameter, as on the server. */
    fun personalFriUrl(friUrl: String, student: String) = friUrl.substringBefore('?') + "?student=" + student

    fun decodeHtml(value: String): List<String> = value
        .replace(Regex("<script[\\s\\S]*?</script>|<style[\\s\\S]*?</style>", ci), " ")
        .replace(Regex("<br\\s*/?>", ci), "\n")
        .replace(Regex("<[^>]+>"), " ")
        .replace("&nbsp;", " ").replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'")
        .replace(Regex("&[a-z]+;", ci), " ")
        .replace("\r", "")
        .split('\n')
        .map { it.replace(Regex("\\s+"), " ").trim() }
        .filter { it.isNotEmpty() }

    fun parseFri(html: String, weekStart: LocalDate): List<Lesson> {
        if (!Regex("allocations|timetable", ci).containsMatchIn(html)) throw ApiException("FRI je spremenil obliko strani.")
        return html.split(Regex("<div class=\"grid-entry\"\\s", ci)).drop(1).mapNotNull { entry ->
            val day = Regex("data-day=\"([A-Z]{3})\"", ci).find(entry)?.groupValues?.get(1)?.uppercase() ?: return@mapNotNull null
            val start = Regex("data-start=\"(\\d{2}:\\d{2})\"", ci).find(entry)?.groupValues?.get(1) ?: return@mapNotNull null
            val duration = Regex("data-duration=\"(\\d+)\"", ci).find(entry)?.groupValues?.get(1)?.toIntOrNull() ?: return@mapNotNull null
            val hover = Regex("class=\"entry-hover\">([\\s\\S]*?)</div>", ci).find(entry)?.groupValues?.get(1) ?: return@mapNotNull null
            val offset = dayIndex[day] ?: return@mapNotNull null
            val lines = decodeHtml(hover.replace(Regex("<!--[\\s\\S]*?-->"), ""))
            val room = lines.getOrNull(1) ?: "Lokacija ni navedena"
            val title = (lines.getOrNull(2) ?: "FRI obveznost").replace(Regex("\\(\\d+\\)_[A-Z]+$"), "").trim()
            val teacher = lines.getOrNull(3) ?: ""
            val type = Regex("class=\"entry-type\">\\|\\s*([^<\\s]+)", ci).find(entry)?.groupValues?.get(1) ?: "FRI"
            val startMinutes = start.substring(0, 2).toInt() * 60 + start.substring(3).toInt()
            Lesson("fri-$day-$start-$title", title, type, weekStart.plusDays(offset.toLong()).toString(), start, time(startMinutes + duration * 60), room, teacher, "FRI")
        }
    }

    fun parseFmf(html: String, weekStart: LocalDate): List<Lesson> {
        if (!Regex("id=\"timetable\"", ci).containsMatchIn(html)) throw ApiException("FMF je spremenil obliko strani.")
        return html.split(Regex("<div class=\"entry-absolute-box\\b", ci)).drop(1).mapNotNull { block ->
            val style = Regex("style=\"([^\"]*)\"", ci).find(block)?.groupValues?.get(1) ?: ""
            val left = Regex("left:\\s*([\\d.]+)%", ci).find(style)?.groupValues?.get(1)?.toDoubleOrNull() ?: return@mapNotNull null
            val top = Regex("top:\\s*([\\d.]+)%", ci).find(style)?.groupValues?.get(1)?.toDoubleOrNull() ?: return@mapNotNull null
            val height = Regex("height:\\s*([\\d.]+)%", ci).find(style)?.groupValues?.get(1)?.toDoubleOrNull() ?: return@mapNotNull null
            val title = Regex("class=\"subject\"[^>]*>[\\s\\S]*?([^<>]+)</a>", ci).find(block)?.groupValues?.get(1)
                ?.replace(Regex("\\s+"), " ")?.replace("&amp;", "&")?.replace("&quot;", "\"")?.replace("&#39;", "'")?.trim()
                ?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val type = Regex("class=\"entry-type\">\\s*([^<]+)", ci).find(block)?.groupValues?.get(1)?.trim() ?: "FMF"
            val room = Regex("class=\"classroom[^>]*>[\\s\\S]*?<a[^>]*title=\"([^\"]+)", ci).find(block)?.groupValues?.get(1) ?: "Lokacija ni navedena"
            val teacher = Regex("class=\"teacher\">[\\s\\S]*?<a[^>]*title=\"([^\"]+)", ci).find(block)?.groupValues?.get(1) ?: ""
            val startMinutes = (top / 100 * 13 * 60 + 7 * 60).roundToInt()
            val endMinutes = startMinutes + (height / 100 * 13 * 60).roundToInt()
            val dayOffset = (left / 20).roundToInt()
            Lesson("fmf-$dayOffset-$startMinutes-$title-$room", title, type, weekStart.plusDays(dayOffset.toLong()).toString(), time(startMinutes), time(endMinutes), room, teacher, "FMF")
        }
    }

    private fun time(minutes: Int) = "${(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}"
}
