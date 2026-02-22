// ==UserScript==
// @name         4chan Local dHash Swapper/TSD
// @namespace    http://tampermonkey.net/
// @version      5.8
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
// ==/UserScript==

(function () {
    'use strict';

    const API = 'http://127.0.0.1:5150';
    const MAX_CONCURRENT = 3;
    const swappedPostIds = new Set();
    const scanQueue = [];
    let activeScans = 0;
    let scanTimeout;

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

    async function swapImage(thumbImg) {
        const fileDiv = thumbImg.closest('div.file');
        if (!fileDiv) return;
        if (fileDiv.dataset.swapped) return;
        fileDiv.dataset.swapped = 'true';

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
            if (res.swap) await swapImage(img);
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
            swapImage(img);
        } catch (err) {
            console.error('[dHash] Save failed:', err);
        }
    }, true);

    // --- Init ---

    scanPage();

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