package eu.majmohar.isrm

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.time.DayOfWeek
import java.time.LocalDate

data class Lesson(val id: String, val title: String, val type: String, val date: String, val start: String, val end: String, val room: String, val teacher: String, val source: String, val cancelled: Boolean = false, val cancelNote: String = "")

/** An admin message shown as a banner to everyone in the programme until it expires. */
data class Announcement(val id: String, val text: String, val createdAt: String)

/** One week or month as the server returned it. `sources` maps FRI/FMF to whether that faculty's feed is reachable. */
data class Schedule(val events: List<Lesson>, val fetchedAt: String = "", val sources: Map<String, Boolean> = emptyMap(), val error: String = "", val announcements: List<Announcement> = emptyList())

class ApiException(message: String) : Exception(message)

/** The saved admin key was revoked (removed elsewhere, or the admin password changed). */
class AdminRevokedException : Exception("Dostop za urejanje ni več veljaven. Za urejanje znova vnesi geslo.")

class TimetableRepository(private val context: Context) {
    private val store = context.getSharedPreferences("timetable-cache", Context.MODE_PRIVATE)
    private val base = BuildConfig.WEB_APP_URL.trimEnd('/')

    private fun key(w: LocalDate, y: String, s: String) = "week-$w-$y-${s.ifBlank { "shared" }}"
    private fun monthKey(m: LocalDate, y: String, s: String) = "month-${m.withDayOfMonth(1)}-$y-${s.ifBlank { "shared" }}"
    private fun studentQuery(s: String) = if (s.isNotBlank()) "&student=${URLEncoder.encode(s, "UTF-8")}" else ""

    fun cached(w: LocalDate, y: String, s: String) = cachedWeek(w, y, s).events
    fun cachedWeek(w: LocalDate, y: String, s: String) = parse(store.getString(key(w, y, s), null))
    fun monthCached(m: LocalDate, y: String, s: String) = parse(store.getString(monthKey(m, y, s), null)).events

    fun refresh(w: LocalDate, y: String, s: String) = loadWeek(w, y, s, false).events

    // A copy saved within FRESH_MS is shown without asking the server again — most opens are quick re-checks of the same week.
    fun weekFresh(w: LocalDate, y: String, s: String) = System.currentTimeMillis() - store.getLong("at-${key(w, y, s)}", 0) < FRESH_MS
    fun monthFresh(m: LocalDate, y: String, s: String) = System.currentTimeMillis() - store.getLong("at-${monthKey(m, y, s)}", 0) < FRESH_MS

    /**
     * Throws only when nothing usable came back; a 503 that still carries the last stored events is returned with `error`
     * set. When the IŠRM server itself is unreachable (or answers with a server error and no data), the week is read
     * straight from FRI and FMF instead — see [DirectSource].
     */
    fun loadWeek(w: LocalDate, y: String, s: String, force: Boolean): Schedule {
        val (status, text) = runCatching { get("/api/timetable?week=$w&programme=$y${studentQuery(s)}${if (force) "&refresh=1" else ""}") }
            .getOrElse { return directWeek(w, y, s) }
        val schedule = parse(text)
        if (status in 200..299) {
            store.edit().putString(key(w, y, s), text).putLong("at-${key(w, y, s)}", System.currentTimeMillis()).apply()
            syncSources()
            return schedule
        }
        if (schedule.events.isNotEmpty()) return schedule.copy(error = errorOf(text, "Prikazani so zadnji shranjeni podatki."))
        if (status >= 500) return directWeek(w, y, s)
        throw ApiException(errorOf(text, "Urnik ni dosegljiv"))
    }

    fun refreshMonth(m: LocalDate, y: String, s: String): List<Lesson> {
        val (status, text) = runCatching { get("/api/month?month=${m.year}-${m.monthValue.toString().padStart(2, '0')}&programme=$y${studentQuery(s)}") }
            .getOrElse { return directMonth(m, y, s) }
        if (status >= 500) return directMonth(m, y, s)
        if (status !in 200..299) throw ApiException(errorOf(text, "Mesečni urnik ni dosegljiv"))
        store.edit().putString(monthKey(m, y, s), text).putLong("at-${monthKey(m, y, s)}", System.currentTimeMillis()).apply()
        return parse(text).events
    }

    // ---- Failsafe: the IŠRM server is down, so read the faculties directly ----

    private fun directWeek(w: LocalDate, y: String, s: String): Schedule {
        val urls = sourceUrls(y)
        val fri = runCatching { DirectSource.parseFri(DirectSource.friPage(if (s.isNotBlank()) DirectSource.personalFriUrl(urls.fri, s) else urls.fri), w) }
        val fmf = runCatching { DirectSource.parseFmf(DirectSource.fetch("${urls.fmf}${if (urls.fmf.contains('?')) "&" else "?"}day=$w"), w) }
        if (fri.isFailure && fmf.isFailure) throw ApiException("Strežnik IŠRM in strani FRI/FMF trenutno niso dosegljivi. Prikazan je shranjen urnik.")
        val previous = cachedWeek(w, y, s).events
        // Admin-added events exist only on the IŠRM server, so the last known ones are kept; a failed source keeps its old rows.
        val events = (fri.getOrElse { previous.filter { it.source == "FRI" } } + fmf.getOrElse { previous.filter { it.source == "FMF" } } + previous.filter { it.source != "FRI" && it.source != "FMF" })
            .sortedWith(compareBy({ it.date }, { it.start }))
            // Cancellations, like messages, are only known to the server: keep the last ones seen.
            .map { lesson -> previous.firstOrNull { it.cancelled && it.id == lesson.id && it.date == lesson.date }?.let { lesson.copy(cancelled = true, cancelNote = it.cancelNote) } ?: lesson }
        val schedule = Schedule(events, java.time.Instant.now().toString(), mapOf("FRI" to fri.isSuccess, "FMF" to fmf.isSuccess), "Strežnik IŠRM ni dosegljiv · urnik je naložen neposredno s FRI in FMF.", cachedWeek(w, y, s).announcements)
        // Saved without a freshness stamp, so the next open asks the IŠRM server again first.
        store.edit().putString(key(w, y, s), toJson(schedule)).apply()
        return schedule
    }

    private fun directMonth(m: LocalDate, y: String, s: String): List<Lesson> {
        val first = m.withDayOfMonth(1); val last = first.plusMonths(1).minusDays(1)
        val mondays = generateSequence(first.with(DayOfWeek.MONDAY)) { it.plusWeeks(1) }.takeWhile { it <= last }.toList()
        var anyFresh = false
        val events = mondays.flatMap { monday -> runCatching { directWeek(monday, y, s).events.also { anyFresh = true } }.getOrElse { cachedWeek(monday, y, s).events } }
            .filter { it.date.startsWith(first.toString().substring(0, 7)) }
        if (!anyFresh) throw ApiException("Strežnik IŠRM in strani FRI/FMF trenutno niso dosegljivi.")
        store.edit().putString(monthKey(m, y, s), toJson(Schedule(events))).apply()
        return events
    }

    /** The server's current FRI/FMF links (they change each semester); kept so the failsafe follows them. */
    private fun syncSources() {
        if (sourcesSynced) return
        sourcesSynced = true
        runCatching {
            val (status, text) = get("/api/sources")
            if (status in 200..299 && JSONObject(text).has("programmes")) store.edit().putString("sources", text).apply()
        }
    }

    private fun sourceUrls(y: String): DirectSource.Urls = runCatching {
        JSONObject(store.getString("sources", null) ?: "{}").getJSONObject("programmes").getJSONObject(y).let { DirectSource.Urls(it.getString("friUrl"), it.getString("fmfUrl")) }
    }.getOrNull() ?: DirectSource.DEFAULTS[y] ?: DirectSource.DEFAULTS.getValue("1")

    private fun toJson(schedule: Schedule) = JSONObject().apply {
        put("fetchedAt", schedule.fetchedAt)
        put("events", JSONArray().apply { schedule.events.forEach { e -> put(JSONObject().put("id", e.id).put("title", e.title).put("type", e.type).put("date", e.date).put("start", e.start).put("end", e.end).put("room", e.room).put("teacher", e.teacher).put("source", e.source).put("cancelled", e.cancelled).put("cancelNote", e.cancelNote)) } })
        put("sources", JSONObject().apply { schedule.sources.forEach { (name, ok) -> put(name, JSONObject().put("ok", ok)) } })
        put("announcements", JSONArray().apply { schedule.announcements.forEach { put(JSONObject().put("id", it.id).put("text", it.text).put("createdAt", it.createdAt)) } })
    }.toString()

    fun preload(y: String, s: String) {
        val monday = LocalDate.now().with(DayOfWeek.MONDAY)
        (0..5).forEach { val w = monday.plusWeeks(it.toLong()); if (!weekFresh(w, y, s)) runCatching { refresh(w, y, s) } }
    }

    private companion object {
        const val FRESH_MS = 10 * 60_000L
        @Volatile var sourcesSynced = false
    }

    /** Returns the programme id ("1".."3") the server derives from a student number. */
    fun studentProgramme(student: String): String {
        val (status, text) = get("/api/student-programme?student=${URLEncoder.encode(student, "UTF-8")}")
        if (status !in 200..299) throw ApiException(errorOf(text, "Letnika ni bilo mogoče prepoznati."))
        return JSONObject(text).optString("programme").ifBlank { throw ApiException("Letnika ni bilo mogoče prepoznati.") }
    }

    /** Exchanges the password for a long-lived admin key; only the key is ever stored on the phone. */
    fun adminLogin(password: String): String =
        admin("/api/admin/login", "", JSONObject().put("password", password).put("device", android.os.Build.MODEL)).optString("token").ifBlank { throw ApiException("Prijava ni uspela.") }
    fun adminLogout(token: String) { admin("/api/admin/logout", token, JSONObject()) }

    fun adminAddEvent(password: String, event: JSONObject): Lesson = lesson(admin("/api/admin/events", password, event).getJSONObject("event"))
    /** The server's content revision (bumped on every admin change), or null when it cannot be reached. */
    fun revision(): Long? = runCatching { val (status, text) = get("/api/revision"); if (status in 200..299) JSONObject(text).getLong("revision") else null }.getOrNull()

    fun adminDeleteEvent(password: String, id: String) { admin("/api/admin/events/delete", password, JSONObject().put("id", id)) }
    fun adminCancel(password: String, programme: String, lesson: Lesson, cancelled: Boolean, note: String) {
        admin("/api/admin/cancel", password, JSONObject().put("programme", programme).put("eventId", lesson.id).put("date", lesson.date).put("cancelled", cancelled).put("note", note))
    }
    fun adminAnnounce(password: String, programme: String, text: String, days: Int) {
        admin("/api/admin/announcements", password, JSONObject().put("programme", programme).put("text", text).put("days", days))
    }
    fun adminDeleteAnnouncement(password: String, id: String) { admin("/api/admin/announcements/delete", password, JSONObject().put("id", id)) }

    fun calendarUrl(w: LocalDate, y: String, s: String) = "$base/api/calendar?week=$w&programme=$y${studentQuery(s)}"
    fun subscriptionUrl(y: String, s: String) = "$base/api/calendar/subscription?programme=$y${studentQuery(s)}"

    private fun admin(path: String, token: String, body: JSONObject): JSONObject {
        val connection = (URL(base + path).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"; doOutput = true; connectTimeout = 8000; readTimeout = 8000
            setRequestProperty("content-type", "application/json")
            if (token.isNotBlank()) setRequestProperty("x-isrm-admin-token", token)
        }
        connection.outputStream.use { it.write(body.toString().toByteArray()) }
        val (status, text) = read(connection)
        if (status == 401 && token.isNotBlank()) throw AdminRevokedException()
        if (status !in 200..299) throw ApiException(errorOf(text, "Administratorska zahteva ni uspela."))
        return JSONObject(text)
    }

    /** Anonymous session ping for the usage statistics described at /privacy. Failures are ignored. */
    fun ping(body: JSONObject) {
        runCatching {
            val connection = (URL("$base/api/ping").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"; doOutput = true; connectTimeout = 8000; readTimeout = 8000
                setRequestProperty("content-type", "application/json")
            }
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
            connection.responseCode
            connection.disconnect()
        }
    }

    private fun get(path: String) = read((URL(base + path).openConnection() as HttpURLConnection).apply { connectTimeout = 8000; readTimeout = 8000 })

    // HttpURLConnection throws from inputStream on 4xx/5xx, but the server puts its message (and stale events) in that body.
    private fun read(connection: HttpURLConnection): Pair<Int, String> {
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        return status to (stream?.bufferedReader()?.use { it.readText() } ?: "")
    }

    private fun errorOf(text: String, fallback: String) = runCatching { JSONObject(text).optString("error") }.getOrNull()?.ifBlank { null } ?: fallback

    private fun lesson(r: JSONObject) = Lesson(r.optString("id"), r.optString("title"), r.optString("type"), r.optString("date"), r.optString("start"), r.optString("end"), r.optString("room"), r.optString("teacher"), r.optString("source"), r.optBoolean("cancelled"), r.optString("cancelNote"))

    private fun parse(text: String?) = runCatching {
        val root = JSONObject(text ?: "{}")
        val list = root.optJSONArray("events") ?: JSONArray()
        val events = (0 until list.length()).map { lesson(list.getJSONObject(it)) }.sortedWith(compareBy({ it.date }, { it.start }))
        val sources = root.optJSONObject("sources")?.let { s -> s.keys().asSequence().associateWith { s.optJSONObject(it)?.optBoolean("ok", true) ?: true } } ?: emptyMap()
        val notes = root.optJSONArray("announcements") ?: JSONArray()
        val announcements = (0 until notes.length()).map { notes.getJSONObject(it).let { n -> Announcement(n.optString("id"), n.optString("text"), n.optString("createdAt")) } }
        Schedule(events, root.optString("fetchedAt"), sources, announcements = announcements)
    }.getOrDefault(Schedule(emptyList()))
}
