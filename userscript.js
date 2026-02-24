// ==UserScript==
// @name         4chan Local dHash Swapper/TSD
// @namespace    http://tampermonkey.net/
// @version      5.9
// @description  Swap matched images via server-side dHash + CLIP
// @match        *://boards.4chan.org/*
// @match        *://boards.4channel.org/*
// @connect      127.0.0.1
// @connect      files.catbox.moe
// @connect      litter.catbox.moe
// @connect      arch.b4k.dev
// @connect      i.4cdn.org
// @connect      4cdn.org
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// ==/UserScript==

(function () {
    'use strict';

    const API = 'http://127.0.0.1:5150';
    const MAX_CONCURRENT = 3;
    const ICON_URL = 'https://prd-game-a3-granbluefantasy.akamaized.net/assets_en/img/sp/quest/scene/character/body/scene_evt250428_ed_24.png';

    const swappedPostIds = new Set();
    const scanQueue = [];
    let activeScans = 0;
    let scanTimeout;
    let scanningEnabled = false;
    let matchCount = { hash: 0, style: 0 };

    // --- Styles ---

    GM_addStyle(`
        #filter-icon {
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 64px;
            height: 64px;
            background-image: url(${ICON_URL});
            background-size: contain;
            background-repeat: no-repeat;
            background-position: center;
            background-color: transparent;
            border: none;
            border-radius: 50%;
            cursor: pointer;
            z-index: 10000;
            opacity: 0.8;
            transition: opacity 0.2s, transform 0.2s;
        }
        #filter-icon:hover {
            opacity: 1;
            transform: scale(1.1);
        }
        #filter-icon.active {
            filter: drop-shadow(0 0 6px rgba(100, 200, 255, 0.8));
        }

        #filter-panel {
            position: fixed;
            bottom: 92px;
            right: 20px;
            width: 280px;
            background: #1d1f21;
            border: 1px solid #444;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            z-index: 9999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 12px;
            color: #c9d1d9;
            display: none;
            overflow: hidden;
        }
        #filter-panel.visible {
            display: block;
        }

        #filter-panel-header {
            background: #161b22;
            padding: 10px 12px;
            font-size: 13px;
            font-weight: 600;
            border-bottom: 1px solid #333;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        #filter-panel-body {
            padding: 10px 12px;
        }

        .filter-section {
            margin-bottom: 10px;
        }
        .filter-section:last-child {
            margin-bottom: 0;
        }

        .filter-section-label {
            font-size: 11px;
            color: #8b949e;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 6px;
        }

        .filter-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 6px;
        }
        .filter-row:last-child {
            margin-bottom: 0;
        }

        .filter-row label {
            flex: 1;
            color: #c9d1d9;
        }

        .filter-slider-group {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .filter-slider {
            -webkit-appearance: none;
            appearance: none;
            width: 100px;
            height: 4px;
            background: #333;
            border-radius: 2px;
            outline: none;
        }
        .filter-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 12px;
            height: 12px;
            background: #58a6ff;
            border-radius: 50%;
            cursor: pointer;
        }
        .filter-slider::-moz-range-thumb {
            width: 12px;
            height: 12px;
            background: #58a6ff;
            border-radius: 50%;
            cursor: pointer;
            border: none;
        }

        .filter-value {
            font-family: monospace;
            font-size: 11px;
            color: #8b949e;
            min-width: 32px;
            text-align: right;
        }

        .filter-toggle {
            position: relative;
            width: 36px;
            height: 20px;
            background: #333;
            border-radius: 10px;
            cursor: pointer;
            transition: background 0.2s;
            border: none;
            padding: 0;
        }
        .filter-toggle.on {
            background: #238636;
        }
        .filter-toggle::after {
            content: '';
            position: absolute;
            top: 2px;
            left: 2px;
            width: 16px;
            height: 16px;
            background: #fff;
            border-radius: 50%;
            transition: transform 0.2s;
        }
        .filter-toggle.on::after {
            transform: translateX(16px);
        }

        .filter-stats {
            display: flex;
            gap: 12px;
            padding: 8px 12px;
            background: #161b22;
            border-top: 1px solid #333;
            font-size: 11px;
            color: #8b949e;
        }
        .filter-stat-num {
            color: #58a6ff;
            font-weight: 600;
        }

        .filter-divider {
            border: none;
            border-top: 1px solid #333;
            margin: 8px 0;
        }

        .filter-score-tooltip {
            display: none;
            position: absolute;
            bottom: 100%;
            left: 0;
            background: rgba(22, 27, 34, 0.95);
            border: 1px solid #444;
            border-radius: 6px;
            padding: 6px 8px;
            z-index: 2001;
            pointer-events: none;
            white-space: nowrap;
            font-family: monospace;
            font-size: 11px;
        }
        .filter-score-row {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            line-height: 1.6;
        }
        .filter-score-label {
            color: #c9d1d9;
        }
        .filter-score-value {
            text-align: right;
        }
    `);

    // --- Panel UI ---

    const icon = document.createElement('div');
    icon.id = 'filter-icon';
    document.body.appendChild(icon);

    const panel = document.createElement('div');
    panel.id = 'filter-panel';
    panel.innerHTML = `
        <div id="filter-panel-header">
            <span>Image Filter</span>
            <button class="filter-toggle" id="filter-master-toggle"></button>
        </div>
        <div id="filter-panel-body">
            <div class="filter-section">
                <div class="filter-section-label">Hash Matching</div>
                <div class="filter-row">
                    <label>Threshold</label>
                    <div class="filter-slider-group">
                        <input type="range" class="filter-slider" id="filter-hash-threshold" min="1" max="20" value="10">
                        <span class="filter-value" id="filter-hash-value">10</span>
                    </div>
                </div>
            </div>
            <hr class="filter-divider">
            <div class="filter-section">
                <div class="filter-section-label">CLIP Style Matching</div>
                <div id="filter-clip-categories"></div>
            </div>
        </div>
        <div class="filter-stats">
            <span>Hash: <span class="filter-stat-num" id="filter-stat-hash">0</span></span>
            <span>Style: <span class="filter-stat-num" id="filter-stat-style">0</span></span>
            <span>Total: <span class="filter-stat-num" id="filter-stat-total">0</span></span>
        </div>
    `;
    document.body.appendChild(panel);

    // --- Panel Logic ---

    icon.addEventListener('click', () => {
        panel.classList.toggle('visible');
    });

    document.addEventListener('click', (e) => {
        if (!panel.contains(e.target) && e.target !== icon && panel.classList.contains('visible')) {
            panel.classList.remove('visible');
        }
    });

    const masterToggle = document.getElementById('filter-master-toggle');
        masterToggle.addEventListener('click', () => {
        scanningEnabled = !scanningEnabled;
        masterToggle.classList.toggle('on', scanningEnabled);
        icon.classList.toggle('active', scanningEnabled);
        if (scanningEnabled) {
            document.querySelectorAll('img[data-filter-match]:not([data-swapped])').forEach(img => {
                swapImage(img, img.dataset.filterMatch);
            });
            scanPage();
        } else {
            scanQueue.length = 0;
        }
        console.log(`[dHash] Scanning ${scanningEnabled ? 'enabled' : 'disabled'}`);
    });

    const hashSlider = document.getElementById('filter-hash-threshold');
    const hashValue = document.getElementById('filter-hash-value');
    let hashDebounce;
    hashSlider.addEventListener('input', () => {
        hashValue.textContent = hashSlider.value;
        clearTimeout(hashDebounce);
        hashDebounce = setTimeout(() => {
            pushConfig({ threshold: parseInt(hashSlider.value) });
        }, 300);
    });

    function updateStats() {
        document.getElementById('filter-stat-hash').textContent = matchCount.hash;
        document.getElementById('filter-stat-style').textContent = matchCount.style;
        document.getElementById('filter-stat-total').textContent = matchCount.hash + matchCount.style;
    }

    function buildCategorySliders(categories) {
        const container = document.getElementById('filter-clip-categories');
        container.innerHTML = '';
        for (const [name, threshold] of Object.entries(categories)) {
            const row = document.createElement('div');
            row.className = 'filter-row';
            row.innerHTML = `
                <label>${name}</label>
                <div class="filter-slider-group">
                    <input type="range" class="filter-slider" data-category="${name}" min="50" max="99" value="${Math.round(threshold * 100)}" step="1">
                    <span class="filter-value" data-category-value="${name}">${threshold.toFixed(2)}</span>
                </div>
            `;
            container.appendChild(row);

            const slider = row.querySelector('input[type="range"]');
            const display = row.querySelector('.filter-value');
            let clipDebounce;
            slider.addEventListener('input', () => {
                const val = (parseInt(slider.value) / 100).toFixed(2);
                display.textContent = val;
                clearTimeout(clipDebounce);
                clipDebounce = setTimeout(() => {
                    pushConfig({ categories: { [name]: parseFloat(val) } });
                }, 300);
            });
        }
    }

    function pushConfig(data) {
        gmPost(`${API}/config`, data).then(res => {
            console.log('[dHash] Config updated:', res);
        }).catch(err => {
            console.warn('[dHash] Config update failed:', err);
        });
    }

    function loadConfig() {
        gmFetch(`${API}/config`).then(text => {
            const config = JSON.parse(text);
            hashSlider.value = config.threshold;
            hashValue.textContent = config.threshold;
            if (config.categories) {
                buildCategorySliders(config.categories);
            }
        }).catch(err => {
            console.warn('[dHash] Failed to load config:', err);
        });
    }

    // --- Title & Favicon Shield ---

    let origTitle = document.title;
    let origFavicon = null;
    let shieldActiveUntil = 0;

    const initLink = document.querySelector('link[rel="shortcut icon"], link[rel="icon"]');
    if (initLink) origFavicon = initLink.href;

    function activateShield() {
        shieldActiveUntil = Date.now() + 2000;
        if (document.title !== origTitle) document.title = origTitle;
        const link = document.querySelector('link[rel="shortcut icon"], link[rel="icon"]');
        if (link && origFavicon && link.href !== origFavicon) {
            link.href = origFavicon;
        }
    }

    new MutationObserver((mutations) => {
        if (Date.now() > shieldActiveUntil) {
            const link = document.querySelector('link[rel="shortcut icon"], link[rel="icon"]');
            if (link && link.href !== origFavicon) origFavicon = link.href;
            return;
        }
        for (const mut of mutations) {
            if (mut.type === 'attributes' && mut.target.tagName === 'LINK') {
                if (mut.target.rel.includes('icon') && mut.target.href !== origFavicon) {
                    mut.target.href = origFavicon;
                }
            }
        }
    }).observe(document.head, { attributes: true, subtree: true, attributeFilter: ['href'] });

    const titleEl = document.querySelector('title');
    if (titleEl) {
        new MutationObserver(() => {
            if (Date.now() > shieldActiveUntil) {
                origTitle = document.title;
                return;
            }
            if (document.title !== origTitle) {
                document.title = origTitle;
            }
        }).observe(titleEl, { childList: true });
    }

    // --- Network Helpers ---

    function gmFetch(url, responseType = '') {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType,
                onload: res => resolve(responseType ? res.response : res.responseText),
                onerror: reject
            });
        });
    }

    function gmPost(url, data) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(data),
                onload: res => resolve(JSON.parse(res.responseText)),
                onerror: reject
            });
        });
    }

    function blobToDataURL(blob) {
        return new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
        });
    }

    function getPostId(container) {
        const id = container?.id?.replace('pc', '');
        return id || null;
    }

    // --- Hover ---

    function showHover(e, src) {
        hideHover();
        const img = document.createElement('img');
        img.id = 'dHash-hover';
        img.src = src;
        Object.assign(img.style, {
            position: 'fixed', zIndex: '2000', maxWidth: '90vw', maxHeight: '90vh',
            border: '1px solid #333', boxShadow: '5px 5px 15px rgba(0,0,0,0.5)',
            pointerEvents: 'none'
        });
        document.body.appendChild(img);
        img.style.left = `${e.clientX + 20}px`;
        img.style.top = `${e.clientY + 20}px`;
        const rect = img.getBoundingClientRect();
        if (rect.right > window.innerWidth) img.style.left = `${e.clientX - rect.width - 20}px`;
        if (rect.bottom > window.innerHeight) img.style.top = `${window.innerHeight - rect.height - 20}px`;
    }

    function hideHover() {
        document.getElementById('dHash-hover')?.remove();
    }

    // --- Score Tooltip ---

    function attachScoreTooltip(img, scores) {
        if (!scores || Object.keys(scores).length === 0) return;

        const tooltip = document.createElement('div');
        tooltip.className = 'filter-score-tooltip';

        for (const [name, score] of Object.entries(scores)) {
            const row = document.createElement('div');
            row.className = 'filter-score-row';

            const label = document.createElement('span');
            label.className = 'filter-score-label';
            label.textContent = name;

            const value = document.createElement('span');
            value.className = 'filter-score-value';
            value.textContent = score.toFixed(4);

            if (score >= 0.8) value.style.color = '#f85149';
            else if (score >= 0.7) value.style.color = '#d29922';
            else value.style.color = '#8b949e';

            row.appendChild(label);
            row.appendChild(value);
            tooltip.appendChild(row);
        }

        const wrapper = img.closest('.fileThumb') || img.parentElement;
        wrapper.style.position = 'relative';
        wrapper.appendChild(tooltip);

        img.addEventListener('mouseover', () => { tooltip.style.display = 'block'; });
        img.addEventListener('mouseout', () => { tooltip.style.display = 'none'; });
    }

    // --- Post Removal ---

    function removeQuoters(postId) {
        swappedPostIds.add(postId);
        document.querySelectorAll(`a.quotelink[href="#p${postId}"]`).forEach(link => {
            const container = link.closest('.postContainer');
            if (!container) return;
            const quoterId = getPostId(container);
            if (quoterId && !swappedPostIds.has(quoterId)) {
                console.log(`[dHash] Removing post >>${quoterId} (quotes swapped >>${postId})`);
                removeQuoters(quoterId);
                document.querySelectorAll(`a.backlink[href="#p${quoterId}"]`).forEach(bl => bl.remove());
                container.remove();
            }
        });
    }

    // --- Swap ---

    async function removePost(img) {
        const postContainer = img.closest('.postContainer');
        const postId = getPostId(postContainer);

        if (postId) {
            removeQuoters(postId);
            document.querySelectorAll(`a.backlink[href="#p${postId}"]`).forEach(bl => bl.remove());
        }

        const wrapper = postContainer?.closest('.replyContainer') || postContainer?.parentElement;
        const thread = document.querySelector('.thread');
        if (wrapper && wrapper !== thread) {
            wrapper.remove();
        } else if (postContainer) {
            postContainer.remove();
        }

        activateShield();
        console.log(`[dHash] Removed post >>${postId}`);
    }

    async function swapImage(thumbImg, method) {
        const fileDiv = thumbImg.closest('div.file');
        if (!fileDiv) return;
        if (fileDiv.dataset.swapped) return;
        fileDiv.dataset.swapped = 'true';

        if (method === 'hash') matchCount.hash++;
        else if (method === 'style') matchCount.style++;
        updateStats();

        let replacement;
        try {
            const text = await gmFetch(`${API}/random_image_base64?t=${Math.random()}`);
            replacement = JSON.parse(text);
            if (replacement.error) replacement = null;
        } catch (e) {
            replacement = null;
        }

        if (!replacement) return removePost(thumbImg);

        const { filename, data } = replacement;

        const post = thumbImg.closest('.post');
        const postContainer = thumbImg.closest('.postContainer');
        const msg = post?.querySelector('blockquote.postMessage');
        const postId = getPostId(postContainer);

        const stop = e => { e.stopPropagation(); e.stopImmediatePropagation(); };

        if (msg) msg.textContent = '';

        fileDiv.innerHTML = '';
        fileDiv.className = 'file';
        fileDiv.dataset.swapped = 'true';

        const fileText = document.createElement('div');
        fileText.className = 'fileText';
        fileText.innerHTML = '<span class="file-info">File (swapped)</span>';

        const link = document.createElement('a');
        link.className = 'fileThumb';
        link.href = 'javascript:;';
        link.dataset.swapped = 'true';

        const img = document.createElement('img');
        img.src = data;
        img.alt = 'swapped';
        img.dataset.md5 = '';
        img.dataset.scanned = 'true';
        img.dataset.swapped = 'true';
        Object.assign(img.style, {
            maxWidth: '125px', maxHeight: '125px', border: '2px solid red',
            margin: '3px 0', cursor: 'pointer', display: 'block'
        });

        link.appendChild(img);
        fileDiv.append(fileText, link);

        link.addEventListener('click', e => {
            stop(e);
            e.preventDefault();
            const collapsed = img.style.maxWidth === '125px';
            img.style.maxWidth = collapsed ? '95vw' : '125px';
            img.style.maxHeight = collapsed ? '95vh' : '125px';
            if (!collapsed) hideHover();
        }, true);

        img.addEventListener('mouseover', e => { stop(e); showHover(e, data); }, true);
        img.addEventListener('mousemove', stop, true);
        img.addEventListener('mouseout', e => { stop(e); hideHover(); }, true);

        if (postId) {
            removeQuoters(postId);
            const blContainer = post?.querySelector('.container');
            if (blContainer) blContainer.innerHTML = '';
            document.querySelectorAll(`a.backlink[href="#p${postId}"]`).forEach(bl => bl.remove());
        }

        activateShield();
        console.log(`[dHash] Swapped: ${filename}`);
    }

    // --- Concurrency-Limited Scan Queue ---

        async function processOne(img) {
        try {
            const thumbUrl = img.src.startsWith('//') ? 'https:' + img.src : img.src;
            const thumbBlob = await gmFetch(thumbUrl, 'blob');
            const thumbB64 = await blobToDataURL(thumbBlob);
            const res = await gmPost(`${API}/check`, { thumbnail_b64: thumbB64 });
            if (res.scores) {
                attachScoreTooltip(img, res.scores);
            }
            if (res.swap) {
                img.dataset.filterMatch = res.method;
                if (scanningEnabled) {
                    await swapImage(img, res.method);
                }
            }
        } catch (e) {
            console.warn('[dHash] Check failed:', e);
        }
    }

    function drainQueue() {
        while (activeScans < MAX_CONCURRENT && scanQueue.length > 0) {
            const img = scanQueue.shift();
            if (img.dataset.swapped || img.closest('[data-swapped]')) continue;
            activeScans++;
            processOne(img).finally(() => {
                activeScans--;
                drainQueue();
            });
        }
    }

        function enqueueImage(img) {
        if (img.dataset.scanned || img.dataset.swapped || img.closest('[data-swapped]')) return;
        if (img.closest('.opContainer')) return;
        img.dataset.scanned = 'true';
        scanQueue.push(img);
        drainQueue();
    }

    function scanPage() {
        document.querySelectorAll('.fileThumb:not([data-swapped]) img:not([data-scanned]):not([data-swapped])').forEach(enqueueImage);
        swappedPostIds.forEach(id => removeQuoters(id));
    }

    function debouncedScan() {
        clearTimeout(scanTimeout);
        scanTimeout = setTimeout(scanPage, 200);
    }

    // --- Alt+Click Save ---

    document.addEventListener('click', async e => {
        if (!e.altKey || e.button !== 0) return;
        const img = e.target.closest('.fileThumb img');
        if (!img) return;

        e.preventDefault();
        e.stopPropagation();

        try {
            const thumbUrl = img.src.startsWith('//') ? 'https:' + img.src : img.src;
            const thumbBlob = await gmFetch(thumbUrl, 'blob');
            const thumbB64 = await blobToDataURL(thumbBlob);

            const res = await gmPost(`${API}/save_thumbnail`, { thumbnail_b64: thumbB64 });
            console.log(`[dHash] Saved: ${res.saved}, total hashes: ${res.count}`);
            swapImage(img, 'hash');
        } catch (err) {
            console.error('[dHash] Save failed:', err);
        }
    }, true);

    // --- Init ---

    loadConfig();

    const thread = document.querySelector('.thread');
    if (thread) {
        new MutationObserver(mutations => {
            for (const mut of mutations) {
                for (const node of mut.addedNodes) {
                    if (!(node instanceof HTMLElement)) continue;
                    const container = node.classList?.contains('postContainer')
                        ? node
                        : node.querySelector?.('.postContainer');
                    if (!container) continue;

                    const quotesSwapped = [...container.querySelectorAll('a.quotelink')].some(link => {
                        const match = link.getAttribute('href')?.match(/#p(\d+)/);
                        return match && swappedPostIds.has(match[1]);
                    });

                    if (quotesSwapped) {
                        const newId = getPostId(container);
                        console.log(`[dHash] Intercepting new post >>${newId} (quotes swapped post)`);
                        swappedPostIds.add(newId);

                        if (newId) {
                            document.querySelectorAll(`a.backlink[href="#p${newId}"]`).forEach(bl => bl.remove());
                        }

                        const wrapper = container.closest('.replyContainer') || container.parentElement;
                        if (wrapper && wrapper !== thread) {
                            wrapper.remove();
                        } else {
                            container.remove();
                        }
                        activateShield();
                    }
                }
            }

            debouncedScan();
        }).observe(thread, { childList: true, subtree: false });
    }

    new MutationObserver(debouncedScan).observe(document.body, { childList: true, subtree: true });

})();