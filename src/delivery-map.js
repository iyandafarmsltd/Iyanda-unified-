/* Iyanda One optional delivery map picker.
 * Uses Leaflet (BSD-2-Clause) and OpenStreetMap tiles with visible attribution.
 * OSM public tile servers are subject to their usage policy and are not an unlimited SLA.
 */
(() => {
  const loadLeaflet = () => new Promise((resolve, reject) => {
    if (window.L) return resolve();
    if (!document.querySelector('link[data-iyanda-leaflet]')) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      css.dataset.iyandaLeaflet = '1';
      document.head.appendChild(css);
    }
    const existing = document.querySelector('script[data-iyanda-leaflet]');
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.dataset.iyandaLeaflet = '1';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Map library could not be loaded.'));
    document.head.appendChild(script);
  });

  const boot = () => {
    const address = document.getElementById('checkoutAddress');
    if (!address || document.getElementById('iyandaMapPicker')) return;
    const wrap = document.createElement('section');
    wrap.id = 'iyandaMapPicker';
    wrap.style.cssText = 'margin:12px 0;padding:12px;border:1px solid #e5e9e2;border-radius:14px;background:#fff';
    wrap.innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between"><strong style="color:#123d2b">Choose delivery location on map</strong><button type="button" id="iyandaMapToggle" class="btn light small">Open free map</button></div><p style="font-size:12px;color:#68756d;margin:8px 0">Optional: enter your address above, then place a pin to help the delivery team locate you. You can also use your device location.</p><div id="iyandaMapTools" style="display:none;margin-top:10px"><button type="button" id="iyandaLocateMe" class="btn light small">Use my current location</button><span id="iyandaMapStatus" role="status" style="font-size:12px;color:#68756d;margin-left:8px">Tap the map to place your pin.</span><div id="iyandaMapCanvas" style="height:260px;margin-top:10px;border-radius:10px;overflow:hidden;background:#eef2ed"></div><small style="display:block;margin-top:6px;color:#68756d">Map data © OpenStreetMap contributors</small></div>';
    address.parentElement.insertAdjacentElement('afterend', wrap);
    let map, marker, selected = null;
    const status = document.getElementById('iyandaMapStatus');
    const setPin = (latlng) => {
      selected = { lat: Number(latlng.lat.toFixed(6)), lng: Number(latlng.lng.toFixed(6)) };
      if (!marker) marker = window.L.marker(selected).addTo(map);
      else marker.setLatLng(selected);
      const clean = address.value.replace(/\n?Map pin: -?\d+(?:\.\d+)?, -?\d+(?:\.\d+)?/g, '').trim();
      address.value = (clean ? clean + '\n' : '') + 'Map pin: ' + selected.lat + ', ' + selected.lng;
      status.textContent = 'Pin selected: ' + selected.lat + ', ' + selected.lng;
    };
    document.getElementById('iyandaMapToggle').addEventListener('click', async () => {
      const tools = document.getElementById('iyandaMapTools');
      const opening = tools.style.display === 'none';
      tools.style.display = opening ? 'block' : 'none';
      if (!opening) return;
      const toggle = document.getElementById('iyandaMapToggle');
      toggle.disabled = true;
      try {
        await loadLeaflet();
        if (!map) {
          map = window.L.map('iyandaMapCanvas').setView([9.082, 8.6753], 6);
          window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
          }).addTo(map);
          map.on('click', (event) => setPin(event.latlng));
        }
        setTimeout(() => map.invalidateSize(), 80);
      } catch (error) {
        status.textContent = error.message || 'Map unavailable. You can still enter your address manually.';
      } finally {
        toggle.disabled = false;
      }
    });
    document.getElementById('iyandaLocateMe').addEventListener('click', () => {
      if (!navigator.geolocation) { status.textContent = 'Location is not supported by this device.'; return; }
      status.textContent = 'Requesting your location permission…';
      navigator.geolocation.getCurrentPosition((position) => {
        const point = { lat: position.coords.latitude, lng: position.coords.longitude };
        map.setView(point, 16);
        setPin(point);
      }, () => { status.textContent = 'Location permission unavailable. You can place a pin manually.'; },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
