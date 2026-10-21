// A deliberately small, deterministic Japanese schedule parser. It requires an explicit
// start time and rejects relative dates that it cannot resolve safely.
export function parseMemo(text, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', templates = []) {
  // Keep timezone helpers inside the exported function so the browser can embed this
  // deterministic parser with Function#toString without losing its dependencies.
  function partsInZone(date, zone) {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map(part => [part.type, part.value]));
    return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) };
  }
  function instantFromWallDate(wallDate, zone) {
    const wallTime = wallDate.getTime();
    let instant = wallTime;
    for (let i = 0; i < 3; i++) {
      const p = partsInZone(new Date(instant), zone);
      const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      const adjustment = represented - wallTime;
      if (!adjustment) break;
      instant -= adjustment;
    }
    return new Date(instant);
  }
  const rawSource = String(text || '').trim();
  const source = rawSource.normalize('NFKC').trim();
  if (!source) return { ok: false, needsClarification: true, reason: 'empty', message: '予定の内容を入力してください。' };

  const nowParts = partsInZone(now, timeZone);
  const date = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, nowParts.hour, nowParts.minute));
  date.setUTCSeconds(0, 0);
  const weekdayMap = { '日曜日': 0, '日曜': 0, '月曜日': 1, '月曜': 1, '火曜日': 2, '火曜': 2, '水曜日': 3, '水曜': 3, '木曜日': 4, '木曜': 4, '金曜日': 5, '金曜': 5, '土曜日': 6, '土曜': 6 };
  const templateMatches = (Array.isArray(templates) ? templates : []).filter(item => item && typeof item.shortcut === 'string' && item.shortcut && rawSource.includes(item.shortcut));
  if (templateMatches.length > 1) return { ok: false, needsClarification: true, reason: 'ambiguous-template', message: '予定テンプレートを1つだけ指定してください。' };
  const template = templateMatches[0] || null;
  const weekdayBatch = source.match(/(今週|来週|再来週)の?\s*([日月火水木金土]曜(?:日)?(?:\s*(?:と|、|,|及び|&|＆)\s*[日月火水木金土]曜(?:日)?)*)/);
  const weekdayMentions = Array.from(source.matchAll(/[日月火水木金土]曜(?:日)?/g));
  const batchWeekdayCount = weekdayBatch ? Array.from(weekdayBatch[2].matchAll(/[日月火水木金土]曜(?:日)?/g)).length : 0;
  if (weekdayMentions.length > 1 && (!weekdayBatch || weekdayMentions.length !== batchWeekdayCount)) return { ok: false, needsClarification: true, reason: 'ambiguous-date', message: '複数の曜日を含む場合は、日付の範囲を確認してください。' };
  const shortcutTokens = Array.from(rawSource.matchAll(/[①-⑳]/g));
  if (shortcutTokens.length > 1) return { ok: false, needsClarification: true, reason: 'ambiguous-template', message: '予定テンプレートを1つだけ指定してください。' };
  if (shortcutTokens.length && !template) return { ok: false, needsClarification: true, reason: 'unknown-template', message: '指定した番号の予定テンプレートが見つかりません。' };
  let dateFound = false;
  let dateToken = '';
  let batchDates = null;
  const absolute = source.match(/(20\d{2})[年./-]\s*(\d{1,2})[月./-]\s*(\d{1,2})日?/);
  const monthDay = !absolute && source.match(/(\d{1,2})月\s*(\d{1,2})日/);
  const slashDay = !absolute && !monthDay && source.match(/(?:^|\s)(\d{1,2})[./](\d{1,2})(?:日)?(?:\s*\([日月火水木金土](?:曜)?\))?(?=\s|$)/);
  // Do not require a digit boundary after 日: Japanese notes often join the
  // clock directly (`10月29日10時`). Pair validation below rejects trailing
  // numeric junk that is not a valid clock or separator.
  const explicitDates = Array.from(source.matchAll(/(?<!\d)(?:(20\d{2})[年./-]\s*\d{1,2}[月./-]\s*\d{1,2}日?|\d{1,2}月\s*\d{1,2}日|\d{1,2}[./]\d{1,2}(?:日)?(?:\s*\([日月火水木金土](?:曜)?\))?)/g));
  if (explicitDates.length > 1) {
    if (template) return { ok: false, needsClarification: true, reason: 'ambiguous-template', message: '複数の日付をまとめる場合は、番号メモではなく各日付と時刻を入力してください。' };
    if (weekdayBatch) return { ok: false, needsClarification: true, reason: 'ambiguous-date', message: '複数の日付指定があります。日付を1つの形式で入力してください。' };
    if (explicitDates.length > 50) return { ok: false, needsClarification: true, reason: 'too-many-events', message: '一度に追加できる予定は50件までです。' };
    if (source.slice(0, explicitDates[0].index).trim()) return { ok: false, needsClarification: true, reason: 'ambiguous-date-time-pair', message: '日付より前の内容を確認してください。各日付の後に時刻を入力してください。' };
    const pairTimePattern = /(?:(午前|午後|朝|昼|夕方|夜)\s*(\d{1,2})(?:[:：](\d{1,2})|時(半|\d{1,2}分?)?)?|(?<!\d)(\d{1,2})[:：](\d{2})|(?<!\d)(\d{1,2})時(半|\d{1,2}分?)?)/g;
    const pairTimes = Array.from(source.matchAll(pairTimePattern));
    if (pairTimes.some(match => match.index < explicitDates[0].index)) return { ok: false, needsClarification: true, reason: 'ambiguous-time', message: '各日付の後に開始時刻を入力してください。' };
    const parsedDates = [];
    for (const match of explicitDates) {
      const token = match[0], full = token.match(/^(20\d{2})[年./-]\s*(\d{1,2})[月./-]\s*(\d{1,2})日?/);
      const jp = !full && token.match(/^(\d{1,2})月\s*(\d{1,2})日/);
      const slash = !full && !jp && token.match(/^(\d{1,2})[./](\d{1,2})/);
      if (!full && !jp && !slash) return { ok: false, needsClarification: true, reason: 'invalid-date', message: '日付を確認してください。' };
      const month = Number(full ? full[2] : jp ? jp[1] : slash[1]);
      const day = Number(full ? full[3] : jp ? jp[2] : slash[2]);
      const explicitYear = full ? Number(full[1]) : null;
      // Infer each year from the reference date rather than forcing memo order
      // to be chronological; people often enter paired dates in reverse order.
      let year = explicitYear || nowParts.year;
      if (!explicitYear && nowParts.month >= 10 && month <= 3 && month < nowParts.month) year++;
      const candidate = new Date(Date.UTC(year, month - 1, day));
      if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return { ok: false, needsClarification: true, reason: 'invalid-date', message: '日付を確認してください。' };
      const entry = { year, month, day, date: candidate };
      parsedDates.push(entry);
    }
    const events = [];
    let lastTimeEnd = 0;
    for (let index = 0; index < explicitDates.length; index++) {
      const dateMatch = explicitDates[index], dateEnd = dateMatch.index + dateMatch[0].length;
      const nextDateStart = index + 1 < explicitDates.length ? explicitDates[index + 1].index : source.length;
      const gap = source.slice(dateEnd, nextDateStart);
      const timesInPair = pairTimes.filter(match => match.index >= dateEnd && match.index < nextDateStart);
      if (!timesInPair.length) return { ok: false, needsClarification: true, reason: 'missing-time', message: 'すべての日付に開始時刻を入力してください。' };
      if (timesInPair.length !== 1) return { ok: false, needsClarification: true, reason: 'ambiguous-time', message: '各日付に開始時刻を1つずつ入力してください。' };
      const clock = timesInPair[0], beforeClock = source.slice(dateEnd, clock.index), afterClock = source.slice(clock.index + clock[0].length, nextDateStart);
      if (!/^[\sの]*$/.test(beforeClock) || (index + 1 < explicitDates.length && !/^[\s、,。・と&＆からのに]*$/.test(afterClock))) return { ok: false, needsClarification: true, reason: 'ambiguous-date-time-pair', message: '各日付と時刻の組み合わせを確認してください。' };
      let hour = Number(clock[2] || clock[5] || clock[7]), minute = Number(clock[3] || clock[6] || 0);
      const suffix = clock[4] || clock[8] || '';
      if (suffix.includes('半')) minute = 30;
      const minuteSuffix = suffix.match(/(\d{1,2})分/); if (minuteSuffix) minute = Number(minuteSuffix[1]);
      const meridiem = clock[1] || '';
      if (['午後', '夕方', '夜'].includes(meridiem) && hour < 12) hour += 12;
      else if (['午前', '朝'].includes(meridiem) && hour === 12) hour = 0;
      else if (meridiem === '昼' && hour < 11) hour += 12;
      if (hour > 23 || minute > 59) return { ok: false, needsClarification: true, reason: 'invalid-time', message: '時刻を確認してください。' };
      const wallDate = new Date(parsedDates[index].date); wallDate.setUTCHours(hour, minute, 0, 0);
      const start = instantFromWallDate(wallDate, timeZone);
      events.push({ title: '', start: start.toISOString(), end: new Date(start.getTime() + 60 * 60000).toISOString(), recurrence: null, timezone: timeZone });
      lastTimeEnd = clock.index + clock[0].length;
    }
    if (pairTimes.some(match => match.index >= lastTimeEnd)) return { ok: false, needsClarification: true, reason: 'ambiguous-time', message: '各日付に開始時刻を1つずつ入力してください。' };
    const trailingMemo = source.slice(lastTimeEnd);
    if (/^\s*(?:と|、|,|&|＆)(?:\s|$)/.test(trailingMemo)) return { ok: false, needsClarification: true, reason: 'ambiguous-date-time-pair', message: '最後の日付と時刻の後に続く内容を確認してください。' };
    let title = trailingMemo.replace(/^[\s、,。・と&＆]*(?:から|開始|に)?[\s、,。・]*/, '').replace(/[、,。・\s]+$/g, '').trim();
    if (!title) return { ok: false, needsClarification: true, reason: 'missing-title', message: '予定の名前を追加してください。' };
    for (const event of events) event.title = title;
    return { ok: true, mode: 'rules', durationSpecified: false, events };
  }
  if (weekdayBatch && (absolute || monthDay || slashDay)) return { ok: false, needsClarification: true, reason: 'ambiguous-date', message: '複数の日付指定があります。日付を1つの形式で入力してください。' };
  if (absolute || monthDay || slashDay) {
    const m = absolute || monthDay || slashDay;
    const year = absolute ? Number(m[1]) : nowParts.year;
    const month = Number(absolute ? m[2] : m[1]);
    const day = Number(absolute ? m[3] : m[2]);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
      return { ok: false, needsClarification: true, reason: 'invalid-date', message: '日付を確認してください。' };
    }
    date.setUTCFullYear(year, month - 1, day);
    dateFound = true;
    dateToken = m[0];
  }
  if (!dateFound) {
    const relative = source.match(/今日|本日|明日|あした|明後日|あさって|今週|来週|再来週|今月|来月/);
    if (relative) {
      const token = relative[0];
      if (weekdayBatch && token !== weekdayBatch[1]) return { ok: false, needsClarification: true, reason: 'ambiguous-date', message: '複数の日付指定があります。日付を1つの形式で入力してください。' };
      dateToken = token;
      if (token === '明日' || token === 'あした') date.setUTCDate(date.getUTCDate() + 1);
      else if (token === '明後日' || token === 'あさって') date.setUTCDate(date.getUTCDate() + 2);
      else if (token === '来週' || token === '再来週' || token === '今週') {
        const weekdayText = source.match(/(?:日|月|火|水|木|金|土)曜(?:日)?/);
        if (!weekdayText) return { ok: false, needsClarification: true, reason: 'ambiguous-date', message: '曜日を指定してください。例: 来週の火曜' };
        const target = weekdayMap[weekdayText[0]];
        const addWeeks = token === '来週' ? 1 : token === '再来週' ? 2 : 0;
        const currentWeekday = (date.getUTCDay() + 6) % 7;
        const targetWeekday = (target + 6) % 7;
        let delta = targetWeekday - currentWeekday + addWeeks * 7;
        date.setUTCDate(date.getUTCDate() + delta);
        if (weekdayBatch && weekdayBatch[1] === token) {
          const dayNames = Array.from(weekdayBatch[2].matchAll(/([日月火水木金土])曜(日)?/g), match => match[1] + (match[2] ? '曜日' : '曜'));
          const weekdays = dayNames.map(name => weekdayMap[name]);
          if (new Set(weekdays).size !== weekdays.length) return { ok: false, needsClarification: true, reason: 'duplicate-weekday', message: '同じ曜日が重複しています。日付を確認してください。' };
          batchDates = weekdays.map(weekday => {
            const candidate = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day));
            const currentMondayDay = (candidate.getUTCDay() + 6) % 7, targetMondayDay = (weekday + 6) % 7;
            candidate.setUTCDate(candidate.getUTCDate() + targetMondayDay - currentMondayDay + addWeeks * 7);
            return candidate;
          });
          date.setTime(batchDates[0].getTime());
          dateToken = weekdayBatch[0];
        } else dateToken = token + 'の' + weekdayText[0];
      } else if (token === '今月' || token === '来月') {
        const dayOfMonth = source.match(/(?:今月|来月)\s*(\d{1,2})日/);
        if (!dayOfMonth) return { ok: false, needsClarification: true, reason: 'ambiguous-date', message: '日付を指定してください。例: 来月15日' };
        date.setUTCMonth(date.getUTCMonth() + (token === '来月' ? 1 : 0), 1);
        date.setUTCDate(Number(dayOfMonth[1]));
        if (date.getUTCDate() !== Number(dayOfMonth[1])) return { ok: false, needsClarification: true, reason: 'invalid-date', message: 'その月に指定した日付はありません。' };
        dateToken = token + dayOfMonth[1] + '日';
      }
    } else {
      const weekdayText = source.match(/(?:(毎週|来週|今週|再来週)の?)?(日|月|火|水|木|金|土)曜(?:日)?/);
      if (weekdayText) {
        const qualifier = weekdayText[1] || '';
        if (!qualifier) return { ok: false, needsClarification: true, reason: 'ambiguous-date', message: '曜日だけでは日付を決められません。例: 来週の火曜' };
        const weekday = weekdayMap[weekdayText[0].replace(/^.*の?/, '')] ?? weekdayMap[weekdayText[2] + '曜'];
        const addWeeks = qualifier === '来週' ? 1 : qualifier === '再来週' ? 2 : 0;
        let delta;
        if (qualifier === '毎週') delta = (weekday - date.getUTCDay() + 7) % 7;
        else {
          const currentWeekday = (date.getUTCDay() + 6) % 7;
          const targetWeekday = (weekday + 6) % 7;
          delta = targetWeekday - currentWeekday + addWeeks * 7;
        }
        date.setUTCDate(date.getUTCDate() + delta);
        dateFound = true;
        dateToken = weekdayText[0];
      }
    }
  }
  // An omitted date means today; a vague date never silently becomes a different day.

  const timeMatch = source.match(/(?:(午前|午後|朝|昼|夕方|夜)\s*(\d{1,2})(?:[:：](\d{1,2})|時(半|\d{1,2}分?)?)?|(?<!\d)(\d{1,2})[:：](\d{2})|(?<!\d)(\d{1,2})時(半|\d{1,2}分?)?)/);
  let meridiem = '', hour, minute = 0;
  const savedDuration = Number(template?.durationMinutes);
  let durationMinutes = Number.isFinite(savedDuration) && savedDuration >= 5 && savedDuration <= 1440 ? savedDuration : 60;
  let durationSpecified = Number.isFinite(savedDuration) && savedDuration >= 5 && savedDuration <= 1440;
  if (timeMatch) {
    hour = Number(timeMatch[2] || timeMatch[5] || timeMatch[7]);
    minute = Number(timeMatch[3] || timeMatch[6] || 0);
    meridiem = timeMatch[1] || '';
    const halfHour = (timeMatch[4] || timeMatch[8] || '').includes('半');
    if (halfHour) minute = 30;
    const minuteSuffix = (timeMatch[4] || timeMatch[8] || '').match(/(\d{1,2})分/);
    if (minuteSuffix) minute = Number(minuteSuffix[1]);
    if (meridiem === '午後' || meridiem === '夕方' || meridiem === '夜') { if (hour < 12) hour += 12; }
    else if ((meridiem === '午前' || meridiem === '朝') && hour === 12) hour = 0;
    else if (meridiem === '昼' && hour < 11) hour += 12;
    if (hour > 23 || minute > 59 || (hour === 24 && minute !== 0)) return { ok: false, needsClarification: true, reason: 'invalid-time', message: '時刻を確認してください。' };
    date.setUTCHours(hour, minute, 0, 0);
  } else if (template && (template.time || template.startTime)) {
    const templateTime = String(template.time || template.startTime).match(/^(\d{1,2}):(\d{2})$/);
    if (!templateTime || Number(templateTime[1]) > 23 || Number(templateTime[2]) > 59) return { ok: false, needsClarification: true, reason: 'invalid-template-time', message: 'テンプレートの時刻を確認してください。' };
    hour = Number(templateTime[1]); minute = Number(templateTime[2]);
    date.setUTCHours(hour, minute, 0, 0);
  } else return { ok: false, needsClarification: true, reason: 'missing-time', message: '開始時刻を追加してください。例: 14時から' };

  const durationSource = source.replace(timeMatch?.[0] || /$^/, ' ');
  const duration = durationSource.match(/(?:所要時間|約)?\s*(\d+)\s*(時間|分)(半)?(?:ほど|くらい|程度)?/);
  if (duration) { durationSpecified = true; durationMinutes = Number(duration[1]) * (duration[2] === '時間' ? 60 : 1) + (duration[3] && duration[2] === '時間' ? 30 : 0); }
  else {
    const range = durationSource.match(/(?:から|〜|～|－|—)\s*(午前|午後|夕方|夜|昼|朝)?\s*(\d{1,2})(?::(\d{2})|時(半|\d{1,2}分?)?)?/);
    if (range) {
      durationSpecified = true;
      let endHour = Number(range[2]);
      if (range[1] === '午後' || range[1] === '夕方' || range[1] === '夜') { if (endHour < 12) endHour += 12; }
      else if ((range[1] === '午前' || range[1] === '朝') && endHour === 12) endHour = 0;
      else if (range[1] === '昼' && endHour < 11) endHour += 12;
      const endMinute = Number(range[3] || (range[4] === '半' ? 30 : (range[4] || '').match(/(\d{1,2})分/)?.[1]) || 0);
      let end = new Date(date);
      end.setUTCHours(endHour, endMinute, 0, 0);
      durationMinutes = Math.round((end - date) / 60000);
      if (durationMinutes <= 0) {
        const impliedOvernight = date.getUTCHours() >= 20 && endHour <= 6;
        const explicitOvernight = (meridiem === '午後' || meridiem === '夕方' || meridiem === '夜') && (range[1] === '午前' || range[1] === '朝');
        if (!impliedOvernight && !explicitOvernight) return { ok: false, needsClarification: true, reason: 'invalid-range', message: '終了時刻が開始時刻より前です。翌日の予定なら日付も指定してください。' };
        durationMinutes += 1440;
      }
    }
  }
  if (durationMinutes < 5 || durationMinutes > 1440) return { ok: false, needsClarification: true, reason: 'invalid-duration', message: '所要時間は5分から24時間の範囲で指定してください。' };
  const titleSource = batchDates ? source.replace(weekdayBatch[0], ' ') : source;
  const parsedTitle = titleSource
    .replace(/20\d{2}[年./-]\s*\d{1,2}[月./-]\s*\d{1,2}日?/g, '')
    .replace(/\d{1,2}月\s*\d{1,2}日|(?:^|\s)\d{1,2}[./]\d{1,2}(?:日)?(?:\s*\([日月火水木金土](?:曜)?\))?(?=\s|$)/g, ' ')
    .replace(/(?:今日|本日|明日|あした|明後日|あさって|今週|来週|再来週|今月|来月)/g, '')
    .replace(/(?:日|月|火|水|木|金|土)曜(?:日)?/g, '')
    .replace(timeMatch?.[0] || /$^/, '')
    .replace(/(?:所要時間|約)?\s*\d+\s*(?:時間|分)(?:半)?(?:ほど|くらい|程度)?/g, '')
    .replace(/(?:から|〜|～|-|所要時間)\s*(?:\d+\s*(?:時間|分)(?:半)?|(?:午後|午前)?\s*\d{1,2}(?::\d{2})?\s*(?:時)?(?:分)?)(?:ほど|くらい|程度)?/g, '')
    .replace(/毎週|毎日|毎月|繰り返し/g, '')
    .replace(/^\s*(?:(?:に|から|より|の)\s*)+/, '')
    .replace(/[、,。・\s]+$/g, '').replace(/^[、,。・\s]+/g, '').trim();
  const title = template ? String(template.title || '').trim() : parsedTitle;
  if (!title) return { ok: false, needsClarification: true, reason: 'missing-title', message: '予定の名前を追加してください。' };
  const recurrence = /毎週/.test(source) ? 'weekly' : /毎日/.test(source) ? 'daily' : /毎月/.test(source) ? 'monthly' : (template?.recurrence || null);
  const dates = batchDates || [date];
  const events = dates.map(eventDate => {
    const startDate = new Date(eventDate); startDate.setUTCHours(hour, minute, 0, 0);
    const start = instantFromWallDate(startDate, timeZone);
    return { title, start: start.toISOString(), end: new Date(start.getTime() + durationMinutes * 60000).toISOString(), recurrence, timezone: timeZone };
  });
  return {
    ok: true,
    mode: 'rules',
    durationSpecified,
    events,
    ...(events.length === 1 ? { event: events[0] } : {}),
  };
}

// Task dates are required; unlike schedule memos, a missing task date is never today.
// Kept self-contained so the Worker can embed this parser in the page.
export function parseTaskMemo(text, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') {
  function partsInZone(date, zone) {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
    return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) };
  }
  function instantFromWallDate(wallDate, zone) {
    const wallTime = wallDate.getTime(); let instant = wallTime;
    for (let i = 0; i < 3; i++) { const p = partsInZone(new Date(instant), zone); const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second); const adjustment = represented - wallTime; if (!adjustment) break; instant -= adjustment; }
    return new Date(instant);
  }
  const source = String(text || '').normalize('NFKC').trim();
  if (!source) return { ok: false, reason: 'empty', message: 'タスクの内容を入力してください。' };
  const nowParts = partsInZone(now, timeZone);
  const date = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, 12, 0, 0));
  const weekdayMap = { '日曜': 0, '日曜日': 0, '月曜': 1, '月曜日': 1, '火曜': 2, '火曜日': 2, '水曜': 3, '水曜日': 3, '木曜': 4, '木曜日': 4, '金曜': 5, '金曜日': 5, '土曜': 6, '土曜日': 6 };
  let dateToken = '';
  const absolute = source.match(/(20\d{2})[年./-]\s*(\d{1,2})[月./-]\s*(\d{1,2})日?/);
  const monthDay = !absolute && source.match(/(\d{1,2})月\s*(\d{1,2})日/);
  const slashDay = !absolute && !monthDay && source.match(/(?:^|\s)(\d{1,2})[./](\d{1,2})(?:日)?(?:\s*\([日月火水木金土](?:曜)?\))?(?=\s|$)/);
  let matchedDate = absolute || monthDay || slashDay;
  if (matchedDate) {
    const year = absolute ? Number(matchedDate[1]) : nowParts.year;
    const month = Number(absolute ? matchedDate[2] : matchedDate[1]), day = Number(absolute ? matchedDate[3] : matchedDate[2]);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return { ok: false, reason: 'invalid-date', message: 'タスクの日付を確認してください。' };
    date.setUTCFullYear(year, month - 1, day); dateToken = matchedDate[0];
  } else {
    const relative = source.match(/今日|本日|明日|あした|明後日|あさって|今週|来週|再来週|今月|来月/);
    if (relative) {
      const token = relative[0]; dateToken = token;
      if (/^(明日|あした)$/.test(token)) date.setUTCDate(date.getUTCDate() + 1);
      else if (/^(明後日|あさって)$/.test(token)) date.setUTCDate(date.getUTCDate() + 2);
      else if (/^(今週|来週|再来週)$/.test(token)) {
        const weekdayText = source.match(/(?:日|月|火|水|木|金|土)曜(?:日)?/);
        if (!weekdayText) return { ok: false, reason: 'ambiguous-date', message: '曜日を指定してください。例: 来週の火曜' };
        const weekday = weekdayMap[weekdayText[0]]; const addWeeks = token === '来週' ? 1 : token === '再来週' ? 2 : 0;
        const mondayDay = (date.getUTCDay() + 6) % 7, targetDay = (weekday + 6) % 7;
        date.setUTCDate(date.getUTCDate() + targetDay - mondayDay + addWeeks * 7); dateToken += 'の' + weekdayText[0];
      } else if (/^(今月|来月)$/.test(token)) {
        const m = source.match(/(?:今月|来月)\s*(\d{1,2})日/);
        if (!m) return { ok: false, reason: 'ambiguous-date', message: '日付を指定してください。例: 来月15日' };
        date.setUTCMonth(date.getUTCMonth() + (token === '来月' ? 1 : 0), 1); date.setUTCDate(Number(m[1]));
        if (date.getUTCDate() !== Number(m[1])) return { ok: false, reason: 'invalid-date', message: 'その月に指定した日付はありません。' };
        dateToken += m[1] + '日';
      }
    } else {
      const weekday = source.match(/(?:(毎週|来週|今週|再来週)の?)?(日|月|火|水|木|金|土)曜(?:日)?/);
      if (weekday) {
        const qualifier = weekday[1];
        if (qualifier === '毎週') return { ok: false, reason: 'ambiguous-date', message: '繰り返しではなく、タスクの日付を指定してください。' };
        if (!qualifier) return { ok: false, reason: 'ambiguous-date', message: '曜日だけでは日付を決められません。例: 来週の火曜' };
        const dayName = weekday[2] + (source.slice(weekday.index, weekday.index + weekday[0].length).endsWith('曜日') ? '曜日' : '曜');
        const target = weekdayMap[dayName], currentMonday = (date.getUTCDay() + 6) % 7, targetMonday = (target + 6) % 7;
        const weeks = qualifier === '来週' ? 1 : qualifier === '再来週' ? 2 : 0;
        date.setUTCDate(date.getUTCDate() + targetMonday - currentMonday + weeks * 7); dateToken = weekday[0];
      }
    }
  }
  if (!dateToken) return { ok: false, reason: 'missing-date', message: 'タスクの日付を追加してください。例: 明日 買い物' };
  const dateOnlySource = source.replace(dateToken, ' ');
  const timeMatch = dateOnlySource.match(/(?:(午前|午後|朝|昼|夕方|夜)\s*(\d{1,2})(?:[:：](\d{1,2})|時(半|\d{1,2}分?)?)?|(?<!\d)(\d{1,2})[:：](\d{2})|(?<!\d)(\d{1,2})時(半|\d{1,2}分?)?)/);
  let dueTime = null;
  if (timeMatch) {
    let hour = Number(timeMatch[2] || timeMatch[5] || timeMatch[7]), minute = Number(timeMatch[3] || timeMatch[6] || 0);
    if ((timeMatch[4] || timeMatch[8] || '').includes('半')) minute = 30;
    const minuteSuffix = (timeMatch[4] || timeMatch[8] || '').match(/(\d{1,2})分/); if (minuteSuffix) minute = Number(minuteSuffix[1]);
    const meridiem = timeMatch[1];
    if (['午後', '夕方', '夜'].includes(meridiem) && hour < 12) hour += 12;
    else if (['午前', '朝'].includes(meridiem) && hour === 12) hour = 0;
    else if (meridiem === '昼' && hour < 11) hour += 12;
    if (hour > 23 || minute > 59) return { ok: false, reason: 'invalid-time', message: '時刻を確認してください。' };
    dueTime = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'); date.setUTCHours(hour, minute, 0, 0);
  }
  let title = source.replace(absolute?.[0] || monthDay?.[0] || slashDay?.[0] || dateToken, ' ')
    .replace(/(?:今日|本日|明日|あした|明後日|あさって|今週|来週|再来週|今月|来月)/g, ' ')
    .replace(/(?:日|月|火|水|木|金|土)曜(?:日)?/g, ' ')
    .replace(timeMatch?.[0] || /$^/, ' ')
    .replace(/(?:までに|期限|締切)/g, ' ')
    .replace(/[、,。・\s]+/g, ' ').trim();
  if (!title) return { ok: false, reason: 'missing-title', message: 'タスクの内容を追加してください。' };
  const day = date.toISOString().slice(0, 10), start = instantFromWallDate(date, timeZone), end = new Date(start.getTime() + (dueTime ? 5 * 60000 : 60000));
  return { ok: true, mode: 'rules', event: { type: 'task', title, dueDate: day, dueTime, completed: false, start: start.toISOString(), end: end.toISOString(), timezone: timeZone, recurrence: null } };
}
