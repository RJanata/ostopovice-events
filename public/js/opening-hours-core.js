'use strict';

// Výpočet otevírací doby v konkrétní den — společné pro stránku otevíracích dob (opening-hours.js)
// a pro náhled ve správě výjimek (admin-hours.js). Dny jako "YYYY-MM-DD", časy "HH:MM".
window.OpeningHours = (function () {
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_SHORT = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];

  const keyToDate = (key) => new Date(`${key}T00:00:00Z`);
  const addDays = (key, n) => { const d = keyToDate(key); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const weekdayIndex = (key) => (keyToDate(key).getUTCDay() + 6) % 7; // pondělí = 0
  const formatShort = (key) => `${Number(key.slice(8))}. ${Number(key.slice(5, 7))}.`;
  const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const formatTime = (hhmm) => hhmm.replace(/^0(?=\d)/, '');

  /** ISO číslo týdne (sudý / lichý týden u sběrného dvora). */
  function isoWeek(key) {
    const d = keyToDate(key);
    d.setUTCDate(d.getUTCDate() + 3 - weekdayIndex(key)); // čtvrtek téhož týdne určuje rok i číslo týdne
    const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
    return Math.ceil(((d - yearStart) / 864e5 + 1) / 7);
  }

  /** Pravidelná doba platná v daný den (sezóny „duben–říjen“ apod., i přes Nový rok). */
  function regularHours(place, day) {
    if (!place.seasons) return { hours: place.hours, season: null };
    const md = day.slice(5);
    const season = place.seasons.find((s) => (s.from <= s.to ? md >= s.from && md <= s.to : md >= s.from || md <= s.to));
    return { hours: season?.hours || {}, season };
  }

  /** Pravidelné intervaly v daný den: [{ from, to, note }], prázdné = zavřeno, null = neznámé. */
  function regularIntervals(place, day) {
    const { hours } = regularHours(place, day);
    if (!hours) return null;
    const week = isoWeek(day);
    return (hours[DAYS[weekdayIndex(day)]] || [])
      .map((item) => (typeof item === 'string' ? { time: item } : item))
      .filter((item) => !item.weeks || (item.weeks === 'even') === (week % 2 === 0))
      .map((item) => ({ from: item.time.split('-')[0], to: item.time.split('-')[1], note: item.note || '' }));
  }

  /** Výjimka platná pro místo v daný den (exceptions s places, starší tvar s place). */
  function exceptionOn(exceptions, place, day) {
    return exceptions.find((x) => (x.places || [x.place]).includes(place.id) && day >= x.from && day <= (x.to || x.from)) || null;
  }

  const exceptionIntervals = (exception) => exception.hours.map((t) => ({ from: t.split('-')[0], to: t.split('-')[1] }));

  /** Intervaly v daný den včetně výjimky: { exception, intervals }. */
  function hoursOn(exceptions, place, day) {
    const exception = exceptionOn(exceptions, place, day);
    return exception
      ? { exception, intervals: exceptionIntervals(exception) }
      : { exception: null, intervals: regularIntervals(place, day) };
  }

  return {
    DAYS, DAY_SHORT, keyToDate, addDays, weekdayIndex, formatShort, toMinutes, formatTime,
    isoWeek, regularHours, regularIntervals, exceptionOn, exceptionIntervals, hoursOn,
  };
})();
