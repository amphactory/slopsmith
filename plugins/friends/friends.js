(function () {
    'use strict';

    const BASE = '/api/plugins/friends';
    let _status = 'offline';
    let _song = {
        filename: '', title: '', artist: '',
        arrangement: '', duration: 0, difficulty: 100,
        play_at: 0, offset: 0,
    };
    let _heartbeatTimer = null;
    let _pollTimer = null;
    let _sidebarExpanded = localStorage.getItem('friends_sidebar_expanded') !== 'false';
    let _activeTab = 'friends';
    let _notifTotal = 0;
    let _notifSeenCount = parseInt(localStorage.getItem('friends_notif_seen') || '0', 10);
    let _hoverCard = null;
    let _hoverHideTimer = null;
    let _progressTimer = null;

    // ── Auth guard ────────────────────────────────────────────────────────

    function _loggedIn() {
        return !!sessionStorage.getItem('slopsmith_role');
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    function _getMasteryPct() {
        return parseInt(document.getElementById('mastery-slider')?.value ?? '100', 10);
    }

    function _fmt(secs) {
        const s = Math.max(0, Math.floor(secs || 0));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    function _estimatedPos(info) {
        const playAt = parseInt(info?.song_play_at || 0, 10);
        const offset = parseFloat(info?.song_offset || 0);
        if (playAt > 0) return offset + (Date.now() / 1000 - playAt / 1000);
        return offset;
    }

    // ── Status ────────────────────────────────────────────────────────────

    async function postStatus(status) {
        if (!_loggedIn()) return;
        _status = status;
        const busy = status === 'busy';
        try {
            await fetch(`${BASE}/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status,
                    song_filename:    busy ? _song.filename    : '',
                    song_title:       busy ? _song.title       : '',
                    song_artist:      busy ? _song.artist      : '',
                    song_arrangement: busy ? _song.arrangement : '',
                    song_play_at:     busy ? _song.play_at     : 0,
                    song_offset:      busy ? _song.offset      : 0,
                    song_duration:    busy ? _song.duration    : 0,
                    song_difficulty:  busy ? _song.difficulty  : -1,
                }),
            });
        } catch (_) {}
    }

    function _beaconOffline() {
        if (!_loggedIn()) return;
        navigator.sendBeacon(
            `${BASE}/status`,
            new Blob([JSON.stringify({
                status: 'offline', song_filename: '', song_title: '',
                song_artist: '', song_arrangement: '',
                song_play_at: 0, song_offset: 0, song_duration: 0, song_difficulty: -1,
            })], { type: 'application/json' })
        );
    }

    function _startHeartbeat() {
        if (_heartbeatTimer) return;
        _heartbeatTimer = setInterval(() => postStatus(_status), 90_000);
    }

    // ── Hooks ─────────────────────────────────────────────────────────────

    function _hookPlaySong() {
        const orig = window.playSong;
        if (!orig) return;
        window.playSong = async function (filename, arrangement) {
            let title = filename.replace(/\.(psarc|sloppak)$/i, '');
            let artist = '';
            const cards = document.querySelectorAll('[data-filename]');
            for (const card of cards) {
                if (card.dataset.filename === filename) {
                    const titleEl = card.querySelector('.song-title, .title, [class*="title"]');
                    if (titleEl) title = titleEl.textContent.trim() || title;
                    const artistEl = card.querySelector('.artist, .band, .song-artist, [class*="artist"], [class*="band"]');
                    if (artistEl) artist = artistEl.textContent.trim();
                    break;
                }
            }
            // Set known info immediately; arrangement/duration/play_at filled by slopsmith events
            _song.filename = filename;
            _song.title = title;
            _song.artist = artist;
            _song.arrangement = '';
            _song.duration = 0;
            _song.play_at = 0;
            _song.offset = 0;
            _song.difficulty = _getMasteryPct();
            postStatus('busy');
            return orig.apply(this, arguments);
        };
    }

    function _hookSlopsmith() {
        const sm = window.slopsmith;
        if (!sm || typeof sm.addEventListener !== 'function') {
            setTimeout(_hookSlopsmith, 500);
            return;
        }

        sm.addEventListener('song:loaded', () => {
            const info = window.slopsmith?.currentSong;
            if (!info) return;
            _song.arrangement = info.arrangement || '';
            _song.duration = info.duration || 0;
            _song.difficulty = info.difficulty != null ? info.difficulty : _getMasteryPct();
            if (_status === 'busy') postStatus('busy');
        });

        sm.addEventListener('song:play', e => {
            const d = e.detail || {};
            _song.play_at = Date.now();
            _song.offset = d.audioT || 0;
            _song.difficulty = d.difficulty != null ? d.difficulty : _getMasteryPct();
            postStatus('busy');
        });

        sm.addEventListener('song:pause', e => {
            _song.play_at = 0;
            _song.offset = (e.detail || {}).audioT || 0;
            postStatus('online');
        });

        sm.addEventListener('song:ended', () => {
            _song.play_at = 0;
            _song.offset = 0;
            postStatus('online');
        });

        sm.addEventListener('song:seek', e => {
            const d = e.detail || {};
            _song.offset = d.to || 0;
            _song.play_at = window.slopsmith.isPlaying ? Date.now() : 0;
            if (_status === 'busy') postStatus('busy');
        });

        sm.addEventListener('song:mastery-changed', e => {
            _song.difficulty = e.detail?.difficulty ?? _song.difficulty;
            if (_status === 'busy') postStatus('busy');
        });
    }

    // ── Utils ─────────────────────────────────────────────────────────────

    function _esc(str) {
        const d = document.createElement('div');
        d.textContent = String(str ?? '');
        return d.innerHTML;
    }

    async function _api(path, opts) {
        const r = await fetch(`${BASE}${path}`, opts);
        if (!r.ok) throw new Error(await r.text());
        return r.json();
    }

    function _timeAgo(ts) {
        const diff = Math.floor(Date.now() / 1000) - ts;
        if (diff < 60) return 'just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        return `${Math.floor(diff / 86400)}d ago`;
    }

    // ── Render helpers ────────────────────────────────────────────────────

    function _statusDotClass(info) {
        const s = info?.status || 'offline';
        return { online: 'bg-green-400', busy: 'bg-yellow-400', away: 'bg-gray-400', offline: 'bg-gray-600' }[s] || 'bg-gray-600';
    }

    function _avatar(userId, displayName, cls = 'w-8 h-8') {
        const fallback = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' fill='%231e1e3a'/><text x='50%25' y='55%25' text-anchor='middle' dominant-baseline='middle' fill='%234080e0' font-size='16' font-family='sans-serif'>${encodeURIComponent((displayName?.[0] || '?').toUpperCase())}</text></svg>`;
        return `<img src="/api/profile/avatar/${userId}" onerror="this.src='${fallback}'" class="${cls} rounded-full object-cover flex-shrink-0 bg-dark-600" alt="">`;
    }

    // ── Hover card ────────────────────────────────────────────────────────

    function _initHoverCard() {
        _hoverCard = document.createElement('div');
        _hoverCard.id = 'fs-hover-card';
        _hoverCard.className = 'fixed z-[200] w-52 bg-dark-800 border border-gray-700 rounded-xl shadow-2xl p-3 text-sm';
        _hoverCard.style.display = 'none';
        _hoverCard.addEventListener('mouseenter', () => clearTimeout(_hoverHideTimer));
        _hoverCard.addEventListener('mouseleave', _scheduleHideCard);
        document.body.appendChild(_hoverCard);
    }

    function _stopProgressTicker() {
        clearInterval(_progressTimer);
        _progressTimer = null;
    }

    function _startProgressTicker(info) {
        _stopProgressTicker();
        const duration = parseFloat(info?.song_duration || 0);
        if (!duration) return;

        function tick() {
            const bar = document.getElementById('fs-hc-prog-bar');
            const label = document.getElementById('fs-hc-prog-label');
            if (!bar && !label) { _stopProgressTicker(); return; }
            const pos = Math.min(_estimatedPos(info), duration);
            const pct = (pos / duration) * 100;
            if (bar) bar.style.width = `${pct}%`;
            if (label) label.textContent = `${_fmt(pos)} / ${_fmt(duration)}`;
        }
        tick();
        const isPlaying = parseInt(info?.song_play_at || 0) > 0;
        if (isPlaying) _progressTimer = setInterval(tick, 500);
    }

    function _scheduleHideCard() {
        clearTimeout(_hoverHideTimer);
        _stopProgressTicker();
        _hoverHideTimer = setTimeout(() => {
            if (_hoverCard) _hoverCard.style.display = 'none';
        }, 150);
    }

    function _showHoverCard(friend, rowEl) {
        clearTimeout(_hoverHideTimer);
        if (!_hoverCard) return;
        const rect = rowEl.getBoundingClientRect();
        const si = friend.status_info || {};
        const isBusy = si.status === 'busy';
        const hasSong = isBusy && !!si.song_filename;
        const hasDuration = isBusy && parseFloat(si.song_duration || 0) > 0;
        const statusLabel = { online: 'Online', busy: 'Practicing', away: 'Away', offline: 'Offline' }[si.status] || 'Offline';
        const arrangement = si.song_arrangement || '';
        const difficulty = parseInt(si.song_difficulty ?? -1, 10);
        const arrColor = { Lead: 'bg-blue-600', Rhythm: 'bg-green-700', Bass: 'bg-orange-700' }[arrangement] || 'bg-gray-700';

        _hoverCard.innerHTML = `
            ${hasSong ? `
                <div class="relative mb-3 rounded-lg overflow-hidden bg-dark-700 w-full" style="aspect-ratio:1">
                    <img src="/api/song/${encodeURIComponent(si.song_filename)}/art"
                         class="w-full h-full object-cover"
                         onerror="this.parentElement.style.display='none'">
                    ${arrangement ? `<span class="absolute top-1.5 right-1.5 px-1.5 py-0.5 ${arrColor} text-white text-[10px] font-bold rounded uppercase tracking-wide">${_esc(arrangement)}</span>` : ''}
                    ${difficulty >= 0 ? `<span class="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 bg-black/60 text-white text-[10px] font-medium rounded">Difficulty ${difficulty}%</span>` : ''}
                </div>` : ''}
            <div class="flex items-center gap-2.5 mb-2.5">
                <div class="relative flex-shrink-0">
                    ${_avatar(friend.id, friend.display_name, 'w-10 h-10')}
                    <span class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ${_statusDotClass(si)} border-2 border-dark-800"></span>
                </div>
                <div class="min-w-0">
                    <div class="font-semibold text-white truncate">${_esc(friend.display_name)}</div>
                    <div class="text-xs text-gray-400">${_esc(statusLabel)}</div>
                </div>
            </div>
            ${isBusy && si.song_title ? `
                <div class="mb-2.5 px-2 py-1.5 bg-dark-700/60 rounded-lg border border-gray-800">
                    <div class="text-xs font-medium text-white truncate">${_esc(si.song_title)}</div>
                    ${si.song_artist ? `<div class="text-xs text-gray-400 truncate mt-0.5">${_esc(si.song_artist)}</div>` : ''}
                    ${hasDuration ? `
                        <div class="mt-1.5">
                            <div class="w-full bg-dark-600 rounded-full h-1 overflow-hidden">
                                <div id="fs-hc-prog-bar" class="bg-accent h-1 rounded-full transition-none" style="width:0%"></div>
                            </div>
                            <div id="fs-hc-prog-label" class="text-[10px] text-gray-500 mt-0.5 text-right">0:00 / ${_fmt(parseFloat(si.song_duration))}</div>
                        </div>` : ''}
                </div>` : ''}
            <div class="flex gap-2">
                ${hasSong ? `<button id="fs-hc-play" class="flex-1 px-2 py-1.5 bg-accent hover:bg-accent-light text-white text-xs rounded-lg transition font-medium">&#9654; Play Song</button>` : ''}
                <button id="fs-hc-remove" class="px-2 py-1.5 bg-dark-700 hover:bg-red-900/40 text-gray-400 hover:text-red-400 text-xs rounded-lg transition">Remove</button>
            </div>
        `;

        if (hasSong) {
            _hoverCard.querySelector('#fs-hc-play').addEventListener('click', () => {
                _hoverCard.style.display = 'none';
                _stopProgressTicker();
                window.playSong?.(si.song_filename);
            });
        }
        _hoverCard.querySelector('#fs-hc-remove').addEventListener('click', () => {
            _hoverCard.style.display = 'none';
            _stopProgressTicker();
            window._friendsPlugin.removeFriend(friend.id);
        });

        const cardWidth = 208;
        const gap = 8;
        const top = Math.min(rect.top, window.innerHeight - 260);
        _hoverCard.style.left = `${rect.left - cardWidth - gap}px`;
        _hoverCard.style.top = `${top}px`;
        _hoverCard.style.display = 'block';

        if (hasDuration) _startProgressTicker(si);
    }

    // ── Notifications ─────────────────────────────────────────────────────

    async function _refreshNotifications() {
        const listEl = document.getElementById('fs-notif-list');
        if (!listEl) return;
        try {
            const { notifications } = await _api('/notifications');
            _notifTotal = notifications.length;
            if (_notifSeenCount > _notifTotal) {
                _notifSeenCount = _notifTotal;
                localStorage.setItem('friends_notif_seen', String(_notifSeenCount));
            }
            _updateNotifBadge();

            if (!notifications.length) {
                listEl.innerHTML = `<p class="text-gray-600 text-xs text-center py-6">No notifications</p>`;
                return;
            }
            listEl.innerHTML = notifications.map(n => {
                const msg = n.type === 'friend_request'
                    ? `<b>${_esc(n.from_username)}</b> sent you a friend request`
                    : `<b>${_esc(n.from_username)}</b> accepted your friend request`;
                return `
                    <div class="flex items-start gap-2 px-2 py-2 rounded-lg hover:bg-dark-700/50 transition">
                        ${_avatar(n.from_id, n.from_username, 'w-7 h-7 mt-0.5')}
                        <div class="flex-1 min-w-0">
                            <div class="text-xs text-gray-300 leading-snug">${msg}</div>
                            <div class="text-xs text-gray-600 mt-0.5">${_timeAgo(n.at)}</div>
                        </div>
                    </div>`;
            }).join('');
        } catch (_) {
            if (listEl) listEl.innerHTML = `<p class="text-red-400 text-xs text-center py-4">Failed to load.</p>`;
        }
    }

    function _updateNotifBadge() {
        const badge = document.getElementById('fs-notif-badge');
        if (!badge) return;
        const unseen = Math.max(0, _notifTotal - _notifSeenCount);
        if (unseen > 0) {
            badge.textContent = unseen > 9 ? '9+' : String(unseen);
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    function _markNotifsRead() {
        _notifSeenCount = _notifTotal;
        localStorage.setItem('friends_notif_seen', String(_notifSeenCount));
        _updateNotifBadge();
    }

    // ── Sidebar refresh ───────────────────────────────────────────────────

    async function _refreshSidebarFriends() {
        const listEl = document.getElementById('fs-friends-list');
        const miniEl = document.getElementById('fs-mini-friends');
        if (!listEl) return;

        try {
            const { friends } = await _api('/friends');

            if (!friends.length) {
                listEl.innerHTML = `<p class="text-gray-600 text-xs text-center py-6">No friends yet</p>`;
                if (miniEl) miniEl.innerHTML = '';
                return;
            }

            listEl.innerHTML = friends.map(f => {
                const si = f.status_info || {};
                const isBusy = si.status === 'busy';
                const title = si.song_title || '';
                const artist = si.song_artist || '';
                let subline;
                if (isBusy && title) {
                    subline = artist ? `${_esc(title)} — ${_esc(artist)}` : _esc(title);
                } else {
                    subline = _esc({ online: 'Online', away: 'Away', offline: 'Offline' }[si.status] || 'Offline');
                }
                return `
                    <div class="fs-friend-row flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-dark-700/50 transition cursor-default"
                         data-friend-id="${f.id}">
                        <div class="relative flex-shrink-0">
                            ${_avatar(f.id, f.display_name)}
                            <span class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${_statusDotClass(si)} border-2 border-dark-800"></span>
                        </div>
                        <div class="flex-1 min-w-0">
                            <div class="text-xs font-medium text-white truncate">${_esc(f.display_name)}</div>
                            <div class="text-xs text-gray-500 truncate">${subline}</div>
                        </div>
                    </div>`;
            }).join('');

            friends.forEach(f => {
                const row = listEl.querySelector(`[data-friend-id="${f.id}"]`);
                if (!row) return;
                row.addEventListener('mouseenter', () => _showHoverCard(f, row));
                row.addEventListener('mouseleave', _scheduleHideCard);
            });

            if (miniEl) {
                miniEl.innerHTML = friends.map(f => `
                    <div class="relative flex-shrink-0" title="${_esc(f.display_name)}">
                        ${_avatar(f.id, f.display_name)}
                        <span class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${_statusDotClass(f.status_info)} border-2 border-dark-800"></span>
                    </div>`).join('');
            }
        } catch (_) {
            listEl.innerHTML = `<p class="text-red-400 text-xs text-center py-4">Failed to load.</p>`;
        }
    }

    async function _refreshAll() {
        await Promise.all([_refreshSidebarFriends(), _refreshNotifications()]);
    }

    // ── Tab switching ─────────────────────────────────────────────────────

    function _switchTab(tab) {
        _activeTab = tab;
        const friendsPanel = document.getElementById('fs-panel-friends');
        const notifsPanel  = document.getElementById('fs-panel-notifs');
        const friendsHeader = document.getElementById('fs-friends-header');
        const tabFriends = document.getElementById('fs-tab-friends');
        const tabNotifs  = document.getElementById('fs-tab-notifs');

        const active   = ['border-accent', 'text-white'];
        const inactive = ['border-transparent', 'text-gray-500'];

        if (tab === 'friends') {
            friendsPanel?.classList.remove('hidden');
            notifsPanel?.classList.add('hidden');
            friendsHeader?.classList.remove('hidden');
            tabFriends?.classList.add(...active);
            tabFriends?.classList.remove(...inactive);
            tabNotifs?.classList.remove(...active);
            tabNotifs?.classList.add(...inactive);
        } else {
            friendsPanel?.classList.add('hidden');
            notifsPanel?.classList.remove('hidden');
            friendsHeader?.classList.add('hidden');
            tabFriends?.classList.remove(...active);
            tabFriends?.classList.add(...inactive);
            tabNotifs?.classList.add(...active);
            tabNotifs?.classList.remove(...inactive);
            _markNotifsRead();
            _refreshNotifications();
        }
    }

    // ── Sidebar toggle ────────────────────────────────────────────────────

    function _applySidebarState() {
        const sidebar = document.getElementById('friends-sidebar');
        const mini    = document.getElementById('friends-sidebar-mini');
        if (!sidebar || !mini) return;
        if (_sidebarExpanded) {
            sidebar.classList.remove('hidden');
            mini.classList.add('hidden');
        } else {
            sidebar.classList.add('hidden');
            mini.classList.remove('hidden');
        }
    }

    // ── Add-friend modal ──────────────────────────────────────────────────

    function _openModal() {
        document.getElementById('fp-add-modal')?.classList.remove('hidden');
        document.getElementById('fp-search-input')?.focus();
        _refreshRequests();
    }

    function _closeModal() {
        document.getElementById('fp-add-modal')?.classList.add('hidden');
        const inp = document.getElementById('fp-search-input');
        if (inp) inp.value = '';
        const res = document.getElementById('fp-search-results');
        if (res) res.innerHTML = '';
    }

    async function _refreshRequests() {
        const inEl = document.getElementById('fp-req-in');
        if (!inEl) return;
        try {
            const { incoming } = await _api('/requests');
            if (!incoming.length) {
                inEl.innerHTML = '';
                document.getElementById('fp-req-section')?.classList.add('hidden');
                return;
            }
            document.getElementById('fp-req-section')?.classList.remove('hidden');
            inEl.innerHTML = incoming.map(u => `
                <div class="flex items-center gap-3 p-2 bg-dark-700/40 rounded-xl border border-gray-800">
                    ${_avatar(u.id, u.display_name, 'w-8 h-8')}
                    <span class="flex-1 text-sm text-white truncate">${_esc(u.display_name)}</span>
                    <button onclick="window._friendsPlugin.acceptRequest(${u.id},this)" class="px-2.5 py-1 bg-accent hover:bg-accent-light text-white text-xs rounded-lg transition">Accept</button>
                    <button onclick="window._friendsPlugin.declineRequest(${u.id},this)" class="px-2.5 py-1 bg-dark-600 hover:bg-dark-500 text-gray-300 text-xs rounded-lg transition">Decline</button>
                </div>`).join('');
        } catch (_) {}
    }

    let _searchTimer = null;
    async function _search(q) {
        clearTimeout(_searchTimer);
        const el = document.getElementById('fp-search-results');
        if (!el) return;
        if (!q || q.length < 2) { el.innerHTML = ''; return; }
        _searchTimer = setTimeout(async () => {
            try {
                const { users } = await _api(`/search?q=${encodeURIComponent(q)}`);
                el.innerHTML = users.length
                    ? users.map(u => `
                        <div class="flex items-center gap-3 p-2 hover:bg-dark-700/50 rounded-xl transition">
                            ${_avatar(u.id, u.display_name, 'w-8 h-8')}
                            <div class="flex-1 min-w-0">
                                <div class="text-sm text-white truncate">${_esc(u.display_name)}</div>
                                <div class="text-xs text-gray-500 truncate">@${_esc(u.username)}</div>
                            </div>
                            <button onclick="window._friendsPlugin.sendRequest('${_esc(u.username)}',this)"
                                    class="px-3 py-1 bg-accent hover:bg-accent-light text-white text-xs rounded-lg transition flex-shrink-0">Add</button>
                        </div>`).join('')
                    : '<p class="text-gray-500 text-sm text-center py-3">No users found.</p>';
            } catch (_) {}
        }, 250);
    }

    // ── Sidebar injection ─────────────────────────────────────────────────

    function _injectSidebar() {
        if (document.getElementById('friends-sidebar')) return;

        const userId   = sessionStorage.getItem('slopsmith_user_id') || '';
        const username = sessionStorage.getItem('slopsmith_username') || '?';
        const selfFallback = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' fill='%231e1e3a'/><text x='50%25' y='55%25' text-anchor='middle' dominant-baseline='middle' fill='%234080e0' font-size='16' font-family='sans-serif'>${encodeURIComponent((username[0] || '?').toUpperCase())}</text></svg>`;

        const sidebar = document.createElement('div');
        sidebar.id = 'friends-sidebar';
        sidebar.className = 'fixed right-0 z-40 flex flex-col bg-dark-800 border-l border-gray-800';
        sidebar.style.cssText = 'top:64px; height:calc(100vh - 64px); width:264px;';

        sidebar.innerHTML = `
            <div class="flex items-center gap-2 px-3 py-2.5 border-b border-gray-800 flex-shrink-0">
                <div class="relative flex-shrink-0">
                    <img id="fs-self-avatar" src="/api/profile/avatar/${_esc(userId)}"
                         onerror="this.src='${selfFallback}'"
                         class="w-8 h-8 rounded-full object-cover bg-dark-600" alt="">
                    <span class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-400 border-2 border-dark-800"></span>
                </div>
                <span id="fs-self-name" class="flex-1 text-sm font-medium text-white truncate">${_esc(username)}</span>
                <button onclick="authLogout()" title="Log out"
                        class="text-gray-600 hover:text-red-400 transition p-1 rounded-lg flex-shrink-0">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
                    </svg>
                </button>
                <button onclick="window._friendsPlugin.toggleSidebar()" title="Minimize"
                        class="text-gray-600 hover:text-white transition p-1 rounded-lg flex-shrink-0">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                    </svg>
                </button>
            </div>

            <div class="flex border-b border-gray-800 flex-shrink-0">
                <button id="fs-tab-friends"
                        onclick="window._friendsPlugin.switchTab('friends')"
                        class="flex-1 py-2 text-xs font-medium border-b-2 border-accent text-white transition">
                    Friends
                </button>
                <button id="fs-tab-notifs"
                        onclick="window._friendsPlugin.switchTab('notifications')"
                        class="flex-1 py-2 text-xs font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-300 transition relative">
                    Notifications
                    <span id="fs-notif-badge"
                          class="hidden absolute top-1 right-2 bg-accent text-white text-[10px] font-bold rounded-full min-w-[16px] h-4 inline-flex items-center justify-center px-1 leading-none pointer-events-none">
                    </span>
                </button>
            </div>

            <div id="fs-friends-header" class="flex items-center justify-between px-3 py-2 flex-shrink-0">
                <span class="text-xs font-semibold uppercase tracking-wider text-gray-500">Friends</span>
                <button onclick="window._friendsPlugin.openModal()" title="Add friend"
                        class="text-gray-500 hover:text-accent transition p-1 rounded-lg">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
                    </svg>
                </button>
            </div>

            <div id="fs-panel-friends" class="flex-1 overflow-y-auto px-1 pb-2">
                <div id="fs-friends-list">
                    <p class="text-gray-600 text-xs text-center py-6">Loading...</p>
                </div>
            </div>

            <div id="fs-panel-notifs" class="hidden flex-1 flex flex-col min-h-0">
                <div id="fs-notif-list" class="flex-1 overflow-y-auto px-1 pt-1 pb-2">
                    <p class="text-gray-600 text-xs text-center py-6">Loading...</p>
                </div>
                <div class="flex-shrink-0 px-2 py-2 border-t border-gray-800">
                    <button onclick="window._friendsPlugin.clearNotifications()"
                            class="w-full py-1.5 text-xs text-gray-500 hover:text-white bg-dark-700 hover:bg-dark-600 rounded-lg transition">
                        Clear all
                    </button>
                </div>
            </div>
        `;

        const mini = document.createElement('div');
        mini.id = 'friends-sidebar-mini';
        mini.className = 'fixed right-0 z-40 flex flex-col items-center gap-2 py-2 bg-dark-800 border-l border-gray-800';
        mini.style.cssText = 'top:64px; height:calc(100vh - 64px); width:52px; overflow-y:auto;';

        mini.innerHTML = `
            <button onclick="window._friendsPlugin.toggleSidebar()" title="Expand"
                    class="text-gray-600 hover:text-white transition p-1 rounded-lg flex-shrink-0 mb-1">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
                </svg>
            </button>
            <div class="relative flex-shrink-0">
                <img id="fs-mini-self-avatar" src="/api/profile/avatar/${_esc(userId)}"
                     onerror="this.src='${selfFallback}'"
                     class="w-8 h-8 rounded-full object-cover bg-dark-600" alt="">
                <span class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-400 border-2 border-dark-800"></span>
            </div>
            <div class="w-5 border-t border-gray-700 my-0.5 flex-shrink-0"></div>
            <div id="fs-mini-friends" class="flex flex-col items-center gap-2 w-full px-2 pb-2"></div>
        `;

        document.body.appendChild(sidebar);
        document.body.appendChild(mini);

        _initHoverCard();
        _applySidebarState();
        _injectModal();
    }

    function _injectModal() {
        if (document.getElementById('fp-add-modal')) return;

        const modal = document.createElement('div');
        modal.id = 'fp-add-modal';
        modal.className = 'hidden fixed inset-0 z-50 flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="window._friendsPlugin.closeModal()"></div>
            <div class="relative bg-dark-800 border border-gray-700 rounded-2xl w-full max-w-sm shadow-2xl">
                <div class="p-4 border-b border-gray-800 flex items-center justify-between">
                    <h2 class="text-sm font-semibold text-white">Add Friend</h2>
                    <button onclick="window._friendsPlugin.closeModal()" class="text-gray-500 hover:text-white transition">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                    </button>
                </div>
                <div class="p-4 space-y-3">
                    <div id="fp-req-section" class="hidden space-y-2 pb-3 border-b border-gray-800">
                        <p class="text-xs font-semibold uppercase tracking-wider text-gray-500">Incoming Requests</p>
                        <div id="fp-req-in" class="space-y-2"></div>
                    </div>
                    <input id="fp-search-input" type="text" placeholder="Search by username..."
                           oninput="window._friendsPlugin.search(this.value)"
                           class="w-full px-3 py-2 bg-dark-700 border border-gray-700 rounded-xl text-sm text-white placeholder-gray-500 focus:border-accent/50 focus:ring-1 focus:ring-accent/30 focus:outline-none transition">
                    <div id="fp-search-results" class="space-y-1 max-h-60 overflow-y-auto"></div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    // ── Public API ────────────────────────────────────────────────────────

    window._friendsPlugin = {
        openModal:  _openModal,
        closeModal: _closeModal,
        search:     _search,
        switchTab:  _switchTab,

        toggleSidebar() {
            _sidebarExpanded = !_sidebarExpanded;
            localStorage.setItem('friends_sidebar_expanded', _sidebarExpanded);
            _applySidebarState();
        },

        async sendRequest(username, btn) {
            if (btn) btn.disabled = true;
            try {
                const res = await _api('/friends/request', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username }),
                });
                if (btn) btn.textContent = res.auto_accepted ? 'Friends!' : 'Sent!';
                _closeModal();
                _refreshSidebarFriends();
            } catch (e) {
                if (btn) { btn.disabled = false; btn.textContent = 'Error'; }
            }
        },

        async acceptRequest(userId, btn) {
            if (btn) btn.disabled = true;
            try {
                await _api(`/friends/accept/${userId}`, { method: 'POST' });
                _closeModal();
                _refreshSidebarFriends();
            } catch (_) { if (btn) btn.disabled = false; }
        },

        async declineRequest(userId, btn) {
            if (btn) btn.disabled = true;
            try {
                await _api(`/friends/decline/${userId}`, { method: 'POST' });
                _refreshRequests();
            } catch (_) { if (btn) btn.disabled = false; }
        },

        async removeFriend(userId) {
            if (!confirm('Remove this friend?')) return;
            try {
                await _api(`/friends/${userId}`, { method: 'DELETE' });
                _refreshSidebarFriends();
            } catch (_) {}
        },

        async clearNotifications() {
            try {
                await _api('/notifications/clear', { method: 'POST' });
                _notifTotal = 0;
                _notifSeenCount = 0;
                localStorage.setItem('friends_notif_seen', '0');
                _updateNotifBadge();
                const listEl = document.getElementById('fs-notif-list');
                if (listEl) listEl.innerHTML = `<p class="text-gray-600 text-xs text-center py-6">No notifications</p>`;
            } catch (_) {}
        },
    };

    // ── Boot ──────────────────────────────────────────────────────────────

    function _init() {
        _injectSidebar();
        _hookPlaySong();
        _hookSlopsmith();

        if (_loggedIn()) {
            postStatus('online');
            _startHeartbeat();
            _refreshAll();
            _pollTimer = setInterval(_refreshAll, 15_000);
        }

        window.addEventListener('beforeunload', _beaconOffline);

        document.addEventListener('visibilitychange', () => {
            if (!_loggedIn()) return;
            if (document.hidden) {
                postStatus('away');
            } else {
                if (_song.filename) postStatus('busy');
                else postStatus('online');
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _init);
    } else {
        _init();
    }
})();
