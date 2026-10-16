// Port of PlanScraper — pulls plan/usage details with the partition's session.
// Same 4 endpoints + Bearer/Cookie model as the Android app.
'use strict';

const { cookieHeader, bearerFromValue } = require('./cookies');

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const URLS = {
  stripe: 'https://cursor.com/api/auth/stripe',
  usage: 'https://cursor.com/api/usage',
  usageSummary: 'https://cursor.com/api/usage-summary',
  planInfo: 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo',
};

async function getJson(url, bearer, cheader) {
  const headers = {
    'User-Agent': DESKTOP_UA,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  if (cheader) headers.Cookie = cheader;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  try { return await res.json(); } catch (e) { return null; }
}

async function postJson(url, bearer, body) {
  const headers = {
    'User-Agent': DESKTOP_UA,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  if (!res.ok) return null;
  try { return await res.json(); } catch (e) { return null; }
}

// Mirrors PlanScraper.planSlug: derive a short plan slug from the 3 payloads.
function planSlug(stripe, plan, usageSummary) {
  try {
    const info = (plan && (plan.planInfo || plan)) || {};
    let name = info.planName || info.membershipType || info.individualMembershipType || '';
    name = String(name || '').toLowerCase();
    if (!name || name === 'null' || name === 'none') name = 'unknown';
    const isTeam = info.isTeamMember || /team/.test(name);
    const yearly = info.isYearlyPlan ? '_yearly' : '';
    const student = info.isOnStudentPlan || info.verifiedStudent ? '_student' : '';
    const team = isTeam && !/team/.test(name) ? '_team' : '';
    const paid = isPaid(plan, stripe);
    return (paid ? '' : 'free_') + name.replace(/\s+/g, '_') + yearly + student + team;
  } catch (e) {
    return 'unknown';
  }
}

function isPaid(plan, stripe) {
  try {
    const info = (plan && (plan.planInfo || plan)) || {};
    const t = JSON.stringify(info).toLowerCase() + ' ' + JSON.stringify(stripe || {}).toLowerCase();
    if (/(^|[^a-z])(pro|business|team|ultra)([^a-z]|$)/.test(t) && !/free/.test(t.split('plan')[0] || '')) return true;
    // conservative: any recognizable paid membership marker
    return /"membershipType"\s*:\s*"(pro|business|team|ultra|enterprise)"/.test(JSON.stringify(info));
  } catch (e) {
    return false;
  }
}

async function scrape(sessionCookie, cheader) {
  const bearer = sessionCookie ? bearerFromValue(sessionCookie.value) : '';
  const [stripe, usage, usageSummary] = await Promise.all([
    getJson(URLS.stripe, bearer, cheader),
    getJson(URLS.usage, bearer, cheader),
    getJson(URLS.usageSummary, bearer, cheader),
  ]);
  const plan = await postJson(URLS.planInfo, bearer, {});
  const slug = planSlug(stripe, plan, usageSummary);
  const paid = isPaid(plan, stripe);
  return { stripe, usage, usageSummary, plan, slug, paid };
}

module.exports = { scrape, planSlug, isPaid, URLS };
