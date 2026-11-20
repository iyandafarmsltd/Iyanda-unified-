/* Iyanda One: basic PostHog page-view analytics.
 * Requests use a same-origin Vercel proxy to reduce third-party tracker blocking.
 * Autocapture and session recording are deliberately disabled.
 */
!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2===o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+" (stub)"},o="init capture identify alias people.set people.set_once people.unset people.increment people.append people.remove people.group set_group resetGroups setPersonProperties".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
posthog.init('phc_ByKPsvsv9SwV6upEMVDPs5tKxG8TWkxfKhKvjqJVFSCZ', {
  api_host: '/_ph',
  defaults: '2026-08-30',
  autocapture: false,
  capture_pageview: true,
  disable_session_recording: true
});

// Iyanda One uses hash-based navigation. Record virtual page views when users
// move between in-app sections without a full browser page reload.
window.addEventListener('hashchange', function () {
  posthog.capture('$pageview', { $current_url: window.location.href });
});
