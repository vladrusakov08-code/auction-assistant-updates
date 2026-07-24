// ==UserScript==
// @name         OVE Auction Assistant — VIN Marker + KBB + CARFAX
// @namespace    vord.tools
// @version      2.2.3
// @description  One collapsible sidebar with shared VIN history, KBB Private Party values, and CARFAX summary.
// @match        *://ove.com/*
// @match        *://www.ove.com/*
// @match        *://*.ove.com/*
// @match        *://manheim.com/*
// @match        *://www.manheim.com/*
// @match        *://*.manheim.com/*
// @match        *://copart.com/*
// @match        *://www.copart.com/*
// @match        *://*.copart.com/*
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @connect      identitytoolkit.googleapis.com
// @connect      securetoken.googleapis.com
// @connect      firestore.googleapis.com
// @connect      127.0.0.1
// @connect      carfax-app.vercel.app
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/vladrusakov08-code/auction-assistant-updates/main/ove-auction-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/vladrusakov08-code/auction-assistant-updates/main/ove-auction-assistant.user.js
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const MARKER_HOST = location.hostname.toLowerCase();
    if (!MARKER_HOST.includes('ove.com') && !MARKER_HOST.includes('manheim.com') && !MARKER_HOST.includes('copart.com')) return;

    /* ========================================
       FIREBASE CONFIGURATION
    ======================================== */

    const API_KEY =
        'AIzaSyDdKVdF7Dtpo_8_QhKCpy4usKcV8AAt5rE';

    const PROJECT_ID =
        'vin-tracker-b1a76';

    const IS_COPART =
        location.hostname === 'copart.com' ||
        location.hostname.endsWith('.copart.com');

    const IS_MANHEIM =
        location.hostname === 'manheim.com' ||
        location.hostname.endsWith('.manheim.com');

    const SITE =
        IS_COPART
            ? 'copart'
            : IS_MANHEIM
                ? 'manheim'
                : 'ove';

    const SITE_LABEL =
        SITE.toUpperCase();

    const FIRESTORE_DOCUMENT =
        `projects/${PROJECT_ID}/databases/(default)/documents/ove_sync/state`;

    const FIRESTORE_DOCUMENT_URL =
        `https://firestore.googleapis.com/v1/${FIRESTORE_DOCUMENT}`;

    const FIRESTORE_COMMIT_URL =
        `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:commit`;

    const VLAD_CLOUD_FIELD =
        SITE === 'copart'
            ? 'copartVladLots'
            : 'vladVins';

    const WORKER_CLOUD_FIELD =
        SITE === 'copart'
            ? 'copartWorkerLots'
            : 'workerVins';

    const UPDATED_CLOUD_FIELD =
        SITE === 'copart'
            ? 'copartUpdatedAt'
            : 'updatedAt';

    const DAILY_VLAD_CLOUD_FIELD =
        SITE === 'copart' ? 'copartDailyVladMarks' : 'dailyVladMarks';

    const DAILY_WORKER_CLOUD_FIELD =
        SITE === 'copart' ? 'copartDailyWorkerMarks' : 'dailyWorkerMarks';

    const DAILY_STORAGE = `${SITE}_daily_marks_v1`;
    const ACTIVE_USER_STORAGE = 'vin_marker_active_profile_v1';

    /* ========================================
       COLORS AND USERS
    ======================================== */

    const VLAD = 'vlad';
    const WORKER = 'worker';

    const COLORS = {
        vlad: '#16843d',
        worker: '#7b2cbf',
        both: '#d60000'
    };

    /* ========================================
       STORAGE
    ======================================== */

    const OLD_VIN_STORAGE =
        SITE === 'ove'
            ? 'ove_seen_vins_v1'
            : `${SITE}_seen_vins_v1`;

    const LOCAL_STATE_STORAGE =
        `${SITE}_two_user_state_v2`;

    const SHARED_VIN_STORAGE =
        SITE === 'copart'
            ? 'copart_lot_state_v8'
            : 'ove_manheim_unified_vin_state_v5';

    const SHARED_VIN_MIGRATION =
        `ove_manheim_migrated_${SITE}_v5`;

    const AUTH_STORAGE =
        `${SITE}_firebase_auth_v2`;

    const SHARED_AUTH_STORAGE =
        'firebase_auth_shared_v3';

    const AUTH_BACKOFF_STORAGE =
        'firebase_auth_backoff_until_v4';

    const PANEL_STORAGE =
        `${SITE}_panel_layout_v2`;

    const MIGRATION_STORAGE =
        `${SITE}_old_vins_migrated_v2`;

    const SYNC_LOCK_STORAGE =
        `${SITE}_firebase_sync_lock_v3`;

    const VIN_REGEX =
        /\b[A-HJ-NPR-Z0-9]{17}\b/g;

    const TITLE_REGEX =
        /\b(19|20)\d{2}\s+[A-Z0-9][A-Z0-9 .'"&/()\-]{3,}/i;

    const AUTO_SYNC_INTERVAL = 120000;
    const RATE_LIMIT_PAUSE = 3600000;
    const SYNC_LOCK_DURATION = 30000;

    const TAB_ID =
        typeof crypto?.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random()}`;

    let vladVins = new Set();
    let workerVins = new Set();
    let dailyVladMarks = new Set();
    let dailyWorkerMarks = new Set();
    let statsMode = 'today';
    let hideMode = 'show';
    const filteredCards = new Set();
    const paintedElementStyles = new Map();
    let activeUser = GM_getValue(ACTIVE_USER_STORAGE, '');
    if (![VLAD, WORKER].includes(activeUser)) activeUser = '';

    let auth = loadSharedAuthentication();
    let cloudBusy = false;
    let rateLimitedUntil =
        Number(
            GM_getValue(
                AUTH_BACKOFF_STORAGE,
                0
            )
        ) || 0;
    let cloudStatus = 'CONNECTING...';
    let copartAutoSyncTimer = null;

    /* ========================================
       BASIC STORAGE HELPERS
    ======================================== */

    function loadJson(key, fallback) {
        try {
            return JSON.parse(
                localStorage.getItem(key) || ''
            );
        } catch (_) {
            return fallback;
        }
    }

    function saveJson(key, value) {
        localStorage.setItem(
            key,
            JSON.stringify(value)
        );
    }

    function todayKey() {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Los_Angeles',
            year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(new Date());
    }

    function validDailyMark(value) {
        return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}\|/.test(value);
    }

    function loadDailyMarks() {
        const saved = GM_getValue(DAILY_STORAGE, {}) || {};
        dailyVladMarks = new Set(Array.isArray(saved.vlad) ? saved.vlad.filter(validDailyMark) : []);
        dailyWorkerMarks = new Set(Array.isArray(saved.worker) ? saved.worker.filter(validDailyMark) : []);
    }

    function saveDailyMarks() {
        GM_setValue(DAILY_STORAGE, {
            vlad: [...dailyVladMarks], worker: [...dailyWorkerMarks]
        });
    }

    function loadSharedAuthentication() {
        try {
            const shared =
                GM_getValue(
                    SHARED_AUTH_STORAGE,
                    ''
                );

            if (shared) {
                const parsed =
                    typeof shared === 'string'
                        ? JSON.parse(shared)
                        : shared;

                if (
                    parsed &&
                    typeof parsed === 'object'
                ) {
                    return parsed;
                }
            }
        } catch (_) {}

        return loadJson(
            AUTH_STORAGE,
            {}
        );
    }

    function saveAuthentication() {
        saveJson(
            AUTH_STORAGE,
            auth
        );

        try {
            GM_setValue(
                SHARED_AUTH_STORAGE,
                JSON.stringify(auth)
            );
        } catch (_) {}
    }

    function clearAuthentication() {
        auth = {};

        localStorage.removeItem(
            AUTH_STORAGE
        );

        try {
            GM_setValue(
                SHARED_AUTH_STORAGE,
                ''
            );
        } catch (_) {}
    }

    if (
        auth.idToken ||
        auth.refreshToken
    ) {
        saveAuthentication();
    }

    function validVin(vin) {
        return (
            typeof vin === 'string' &&
            /^[A-HJ-NPR-Z0-9]{17}$/.test(vin)
        );
    }

    function validStoredIdentifier(value) {
        return (
            validVin(value) ||
            (
                typeof value === 'string' &&
                /^LOT:\d{6,12}$/.test(value)
            )
        );
    }

    function loadLocalVinState() {
        const shared =
            loadSharedVinState();

        vladVins = new Set(
            shared.vlad.filter(
                validStoredIdentifier
            )
        );

        workerVins = new Set(
            shared.worker.filter(
                validStoredIdentifier
            )
        );

        const alreadyMigrated =
            Boolean(
                GM_getValue(
                    SHARED_VIN_MIGRATION,
                    false
                )
            );

        if (!alreadyMigrated) {
            const saved =
                loadJson(
                    LOCAL_STATE_STORAGE,
                    {}
                );

            const savedVlad =
                Array.isArray(saved.vlad)
                    ? saved.vlad
                    : [];

            const savedWorker =
                Array.isArray(saved.worker)
                    ? saved.worker
                    : [];

            savedVlad
                .filter(validStoredIdentifier)
                .forEach(vin => {
                    vladVins.add(vin);
                });

            savedWorker
                .filter(validStoredIdentifier)
                .forEach(vin => {
                    workerVins.add(vin);
                });

            const oldVins =
                loadJson(
                    OLD_VIN_STORAGE,
                    []
                );

            if (Array.isArray(oldVins)) {
                oldVins
                    .filter(validStoredIdentifier)
                    .forEach(vin => {
                        vladVins.add(vin);
                    });
            }

            GM_setValue(
                SHARED_VIN_MIGRATION,
                true
            );
        }

        saveLocalVinState();
    }

    function loadSharedVinState() {
        try {
            const raw =
                GM_getValue(
                    SHARED_VIN_STORAGE,
                    ''
                );

            const parsed =
                typeof raw === 'string'
                    ? raw
                        ? JSON.parse(raw)
                        : {}
                    : raw || {};

            return {
                vlad:
                    Array.isArray(parsed.vlad)
                        ? parsed.vlad
                        : [],
                worker:
                    Array.isArray(parsed.worker)
                        ? parsed.worker
                        : []
            };
        } catch (_) {
            return {
                vlad: [],
                worker: []
            };
        }
    }

    function refreshSharedVinState() {
        const shared =
            loadSharedVinState();

        vladVins = new Set(
            shared.vlad.filter(
                validStoredIdentifier
            )
        );

        workerVins = new Set(
            shared.worker.filter(
                validStoredIdentifier
            )
        );
    }

    function saveLocalVinState() {
        const state = {
            vlad: [...vladVins],
            worker: [...workerVins]
        };

        saveJson(
            LOCAL_STATE_STORAGE,
            state
        );

        GM_setValue(
            SHARED_VIN_STORAGE,
            JSON.stringify(state)
        );
    }

    loadLocalVinState();
    loadDailyMarks();

    /* ========================================
       REQUEST HELPER
    ======================================== */

    function request({
        method,
        url,
        body = null,
        headers = {}
    }) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url,

                headers: {
                    ...headers
                },

                data:
                    body === null
                        ? undefined
                        : typeof body === 'string'
                            ? body
                            : JSON.stringify(body),

                timeout: 25000,

                onload(response) {
                    let parsed = {};

                    try {
                        parsed = response.responseText
                            ? JSON.parse(response.responseText)
                            : {};
                    } catch (_) {
                        parsed = {};
                    }

                    if (
                        response.status >= 200 &&
                        response.status < 300
                    ) {
                        resolve(parsed);
                        return;
                    }

                    const error = new Error(
                        parsed?.error?.message ||
                        response.responseText ||
                        `HTTP ${response.status}`
                    );

                    error.status = response.status;
                    error.payload = parsed;
                    error.service =
                        url.includes(
                            'identitytoolkit.googleapis.com'
                        )
                            ? 'AUTH SIGN-UP'
                            : url.includes(
                                'securetoken.googleapis.com'
                            )
                                ? 'AUTH TOKEN'
                                : url.includes(
                                    'firestore.googleapis.com'
                                )
                                    ? 'FIRESTORE'
                                    : 'NETWORK';

                    reject(error);
                },

                onerror() {
                    reject(
                        new Error('Network error')
                    );
                },

                ontimeout() {
                    reject(
                        new Error('Request timed out')
                    );
                }
            });
        });
    }

    /* ========================================
       FIREBASE AUTH
    ======================================== */

    function authStillValid() {
        return (
            auth.idToken &&
            Number(auth.expiresAt) >
                Date.now() + 120000
        );
    }

    async function createAnonymousAccount() {
        const result = await request({
            method: 'POST',

            url:
                'https://identitytoolkit.googleapis.com/v1/' +
                'accounts:signUp?key=' +
                encodeURIComponent(API_KEY),

            headers: {
                'Content-Type': 'application/json'
            },

            body: {
                returnSecureToken: true
            }
        });

        auth = {
            idToken: result.idToken,
            refreshToken: result.refreshToken,
            userId: result.localId,
            expiresAt:
                Date.now() +
                Number(result.expiresIn || 3600) *
                1000
        };

        saveAuthentication();
    }

    async function refreshAuthentication() {
        if (!auth.refreshToken) {
            await createAnonymousAccount();
            return;
        }

        const body =
            'grant_type=refresh_token' +
            '&refresh_token=' +
            encodeURIComponent(
                auth.refreshToken
            );

        const result = await request({
            method: 'POST',

            url:
                'https://securetoken.googleapis.com/v1/' +
                'token?key=' +
                encodeURIComponent(API_KEY),

            headers: {
                'Content-Type':
                    'application/x-www-form-urlencoded'
            },

            body
        });

        auth = {
            idToken: result.id_token,
            refreshToken:
                result.refresh_token ||
                auth.refreshToken,
            userId:
                result.user_id ||
                auth.userId,
            expiresAt:
                Date.now() +
                Number(result.expires_in || 3600) *
                1000
        };

        saveAuthentication();
    }

    async function ensureAuthentication() {
        if (authStillValid()) {
            return auth.idToken;
        }

        try {
            await refreshAuthentication();
        } catch (error) {
            const message =
                String(error.message || '');

            if (
                message.includes(
                    'INVALID_REFRESH_TOKEN'
                ) ||
                message.includes(
                    'TOKEN_EXPIRED'
                ) ||
                message.includes(
                    'USER_NOT_FOUND'
                )
            ) {
                clearAuthentication();

                await createAnonymousAccount();
            } else {
                throw error;
            }
        }

        return auth.idToken;
    }

    function authorizationHeaders() {
        return {
            Authorization:
                `Bearer ${auth.idToken}`,
            'Content-Type':
                'application/json'
        };
    }

    /* ========================================
       FIRESTORE VALUE HELPERS
    ======================================== */

    function stringArrayValue(values) {
        return {
            arrayValue: {
                values: [...new Set(values)]
                    .filter(
                        validStoredIdentifier
                    )
                    .map(value => ({
                        stringValue: value
                    }))
            }
        };
    }

    function readStringArray(field) {
        const values =
            field?.arrayValue?.values;

        if (!Array.isArray(values)) {
            return [];
        }

        return values
            .map(item => item.stringValue)
            .filter(
                validStoredIdentifier
            );
    }

    function readDailyArray(field) {
        const values = field?.arrayValue?.values;
        if (!Array.isArray(values)) return [];
        return values.map(item => item.stringValue).filter(validDailyMark);
    }

    /* ========================================
       FIRESTORE READ
    ======================================== */

    async function downloadCloudState() {
        await ensureAuthentication();

        try {
            const document =
                await request({
                    method: 'GET',
                    url:
                        FIRESTORE_DOCUMENT_URL,
                    headers:
                        authorizationHeaders()
                });

            return {
                vlad: readStringArray(
                    document.fields?.[
                        VLAD_CLOUD_FIELD
                    ]
                ),

                worker: readStringArray(
                    document.fields?.[
                        WORKER_CLOUD_FIELD
                    ]
                ),

                dailyVlad: readDailyArray(document.fields?.[DAILY_VLAD_CLOUD_FIELD]),
                dailyWorker: readDailyArray(document.fields?.[DAILY_WORKER_CLOUD_FIELD])
            };

        } catch (error) {
            if (error.status === 404) {
                return {
                    vlad: [],
                    worker: [],
                    dailyVlad: [],
                    dailyWorker: []
                };
            }

            throw error;
        }
    }

    /* ========================================
       ATOMIC ARRAY UPDATE

       appendMissingElements prevents one Mac
       from overwriting marks added by the other.
    ======================================== */

    async function appendVinsToCloud(
        user,
        vins,
        dailyVins = []
    ) {
        const unique =
            [...new Set(vins)]
                .filter(
                    validStoredIdentifier
                );

        const dailyUnique = [...new Set(dailyVins)]
            .filter(validStoredIdentifier)
            .map(vin => `${todayKey()}|${vin}`);

        if (!unique.length && !dailyUnique.length) return;

        await ensureAuthentication();

        const fieldPath =
            user === VLAD
                ? VLAD_CLOUD_FIELD
                : WORKER_CLOUD_FIELD;

        const dailyFieldPath =
            user === VLAD
                ? DAILY_VLAD_CLOUD_FIELD
                : DAILY_WORKER_CLOUD_FIELD;

        const fieldTransforms = [];
        if (unique.length) fieldTransforms.push({
            fieldPath,
            appendMissingElements: { values: unique.map(vin => ({ stringValue: vin })) }
        });
        if (dailyUnique.length) fieldTransforms.push({
            fieldPath: dailyFieldPath,
            appendMissingElements: { values: dailyUnique.map(value => ({ stringValue: value })) }
        });
        fieldTransforms.push({ fieldPath: UPDATED_CLOUD_FIELD, setToServerValue: 'REQUEST_TIME' });

        await request({
            method: 'POST',

            url:
                FIRESTORE_COMMIT_URL,

            headers:
                authorizationHeaders(),

            body: {
                writes: [
                    {
                        transform: {
                            document:
                                FIRESTORE_DOCUMENT,

                            fieldTransforms
                        }
                    }
                ]
            }
        });
    }

    /* ========================================
       CREATE OR REPLACE STATE DOCUMENT
    ======================================== */

    async function replaceCloudState(
        vlad,
        worker
    ) {
        await ensureAuthentication();

        await request({
            method: 'PATCH',

            url:
                FIRESTORE_DOCUMENT_URL +
                '?updateMask.fieldPaths=' +
                encodeURIComponent(
                    VLAD_CLOUD_FIELD
                ) +
                '&updateMask.fieldPaths=' +
                encodeURIComponent(
                    WORKER_CLOUD_FIELD
                ) +
                '&updateMask.fieldPaths=' +
                encodeURIComponent(
                    UPDATED_CLOUD_FIELD
                ),

            headers:
                authorizationHeaders(),

            body: {
                fields: {
                    [VLAD_CLOUD_FIELD]:
                        stringArrayValue(vlad),

                    [WORKER_CLOUD_FIELD]:
                        stringArrayValue(worker),

                    [UPDATED_CLOUD_FIELD]: {
                        timestampValue:
                            new Date()
                                .toISOString()
                    }
                }
            }
        });
    }

    /* ========================================
       ERROR HANDLING
    ======================================== */

    function formatError(error) {
        const message =
            String(error?.message || error);

        if (
            error?.status === 429 ||
            message.includes('429') ||
            message.includes(
                'TOO_MANY_ATTEMPTS'
            )
        ) {
            rateLimitedUntil =
                Date.now() +
                RATE_LIMIT_PAUSE;

            try {
                GM_setValue(
                    AUTH_BACKOFF_STORAGE,
                    rateLimitedUntil
                );
            } catch (_) {}

            return (
                error?.service ||
                'FIREBASE'
            ) +
                ' LIMITED — LOCAL MODE 1H';
        }

        if (
            error?.status === 403 ||
            message.includes(
                'PERMISSION_DENIED'
            )
        ) {
            return 'CHECK FIRESTORE RULES';
        }

        if (
            message.includes(
                'OPERATION_NOT_ALLOWED'
            )
        ) {
            return 'ENABLE ANONYMOUS AUTH';
        }

        return message
            .replace(/\s+/g, ' ')
            .slice(0, 65);
    }

    /* ========================================
       CLOUD SYNCHRONIZATION
    ======================================== */

    function acquireSyncLock() {
        const now = Date.now();
        const lock = loadJson(
            SYNC_LOCK_STORAGE,
            {}
        );

        if (
            lock.owner &&
            lock.owner !== TAB_ID &&
            Number(lock.expiresAt) > now
        ) {
            return false;
        }

        saveJson(
            SYNC_LOCK_STORAGE,
            {
                owner: TAB_ID,
                expiresAt:
                    now + SYNC_LOCK_DURATION
            }
        );

        return loadJson(
            SYNC_LOCK_STORAGE,
            {}
        ).owner === TAB_ID;
    }

    function releaseSyncLock() {
        const lock = loadJson(
            SYNC_LOCK_STORAGE,
            {}
        );

        if (lock.owner === TAB_ID) {
            localStorage.removeItem(
                SYNC_LOCK_STORAGE
            );
        }
    }

    async function synchronize(force = false) {
        if (cloudBusy) return;

        if (
            Date.now() <
                rateLimitedUntil
        ) {
            const minutes =
                Math.ceil(
                    (
                        rateLimitedUntil -
                        Date.now()
                    ) / 60000
                );

            cloudStatus =
                `LOCAL SAVED — CLOUD RETRY ${minutes}m`;

            updateCounter();
            return;
        }

        try {
            GM_setValue(
                AUTH_BACKOFF_STORAGE,
                0
            );
        } catch (_) {}

        if (!acquireSyncLock()) {
            cloudStatus =
                'SYNCING IN ANOTHER TAB';

            updateCounter();
            return;
        }

        cloudBusy = true;
        cloudStatus = 'SYNCING...';
        updateCounter();

        try {
            const cloud =
                await downloadCloudState();

            cloud.vlad.forEach(vin => {
                vladVins.add(vin);
            });

            cloud.worker.forEach(vin => {
                workerVins.add(vin);
            });

            (cloud.dailyVlad || []).forEach(mark => dailyVladMarks.add(mark));
            (cloud.dailyWorker || []).forEach(mark => dailyWorkerMarks.add(mark));
            saveDailyMarks();

            saveLocalVinState();

            /*
             * Upload local VINs that were not yet
             * present in the cloud. This also migrates
             * the original 295 VINs as Vlad's VINs.
             */

            const missingVlad =
                [...vladVins].filter(
                    vin =>
                        !cloud.vlad.includes(vin)
                );

            const missingWorker =
                [...workerVins].filter(
                    vin =>
                        !cloud.worker.includes(vin)
                );

            if (missingVlad.length) {
                await appendVinsToCloud(
                    VLAD,
                    missingVlad
                );
            }

            if (missingWorker.length) {
                await appendVinsToCloud(
                    WORKER,
                    missingWorker
                );
            }

            if (
                missingVlad.length ||
                missingWorker.length
            ) {
                localStorage.setItem(
                    MIGRATION_STORAGE,
                    'true'
                );
            }

            cloudStatus = 'CLOUD SYNCED';

            paintSeenVins();
            updateCounter();

        } catch (error) {
            console.error(
                `${SITE_LABEL} synchronization error:`,
                error
            );

            cloudStatus =
                'ERROR: ' +
                formatError(error);

            updateCounter();

        } finally {
            cloudBusy = false;
            releaseSyncLock();
        }
    }

    /* ========================================
       OVE VEHICLE DETECTION
    ======================================== */

    function findVehicleCard(
        element,
        vin
    ) {
        let node = element;

        for (
            let i = 0;
            i < 12 &&
            node &&
            node !== document.body;
            i++
        ) {
            const text =
                node.textContent || '';

            const rect =
                node.getBoundingClientRect();

            const vins =
                text.match(VIN_REGEX) || [];

            if (
                vins.includes(vin) &&
                new Set(vins).size === 1 &&
                rect.width > 350 &&
                rect.height > 100 &&
                rect.height < 1000
            ) {
                return node;
            }

            node =
                node.parentElement;
        }

        return element.parentElement;
    }

    function findTitleElement(
        card,
        vinElement
    ) {
        if (!card) return null;

        const preferredElements =
            [...card.querySelectorAll(
                'a, h1, h2, h3, h4, [class*="title" i]'
            )];

        const preferredTitle =
            preferredElements.find(element => {
                if (element === vinElement) {
                    return false;
                }

                const text =
                    element.textContent
                        ?.trim() || '';

                return (
                    text.length >= 8 &&
                    text.length <= 160 &&
                    TITLE_REGEX.test(text) &&
                    !text.match(VIN_REGEX)
                );
            });

        if (preferredTitle) {
            return preferredTitle;
        }

        const elements =
            [...card.querySelectorAll('*')];

        return (
            elements.find(element => {
                if (
                    element === vinElement
                ) {
                    return false;
                }

                if (
                    element.children.length > 2
                ) {
                    return false;
                }

                const text =
                    element.textContent
                        ?.trim() || '';

                return (
                    text.length >= 8 &&
                    text.length <= 140 &&
                    TITLE_REGEX.test(text) &&
                    !text.match(VIN_REGEX)
                );
            }) || null
        );
    }

    function findManheimVinOccurrences() {
        const results = new Map();

        function findManheimTitle(
            card,
            vinElement
        ) {
            const titleCandidates = card
                ? [...card.querySelectorAll(
                    'a.ListingTitle__link, a[href*="#/details/"], a[href*="/details/"], h1, h2, h3, h4'
                )]
                : [];

            const listingTitle = titleCandidates.find(element => {
                const text = element.textContent?.trim() || '';
                return (
                    text.length >= 8 &&
                    text.length <= 160 &&
                    TITLE_REGEX.test(text) &&
                    !text.match(VIN_REGEX) &&
                    !/^Provided\s*:/i.test(text)
                );
            });

            if (listingTitle) {
                return listingTitle;
            }

            let node =
                vinElement?.parentElement;

            for (
                let i = 0;
                i < 20 &&
                node &&
                node !== document.body;
                i++
            ) {
                const headings =
                    [...node.querySelectorAll(
                        'h1, h2, h3, h4, [class*="title" i]'
                    )];

                const title =
                    headings.find(element => {
                        const text =
                            element.textContent
                                ?.trim() || '';

                        return (
                            text.length >= 8 &&
                            text.length <= 160 &&
                            TITLE_REGEX.test(text) &&
                            !text.match(VIN_REGEX) &&
                            !/^Provided\s*:/i.test(text)
                        );
                    });

                if (title) return title;

                node = node.parentElement;
            }

            if (
                location.hash.includes(
                    '/details/'
                )
            ) {
                const pageTitles =
                    [...document.querySelectorAll(
                        'h1, h2, h3, h4, [class*="title" i]'
                    )];

                return (
                    pageTitles.find(element => {
                        const text =
                            element.textContent
                                ?.trim() || '';

                        return (
                            text.length >= 8 &&
                            text.length <= 160 &&
                            TITLE_REGEX.test(text) &&
                            !text.match(VIN_REGEX) &&
                            !/^Provided\s*:/i.test(text)
                        );
                    }) || null
                );
            }

            return null;
        }

        function addOccurrence(
            vin,
            vinElement,
            card = null
        ) {
            vin = vin.toUpperCase();

            if (!validVin(vin)) return;

            const fullText =
                vinElement?.textContent
                    ?.trim()
                    .toUpperCase() || '';

            const score =
                fullText === vin
                    ? 4
                    : fullText.includes(vin)
                        ? 3
                        : fullText ===
                            vin.slice(-8)
                            ? 2
                            : 1;

            const existing =
                results.get(vin);

            if (
                existing &&
                existing.score >= score
            ) {
                return;
            }

            const resolvedCard =
                card ||
                vinElement?.closest(
                    '.SearchResultsDetailView__card-styles'
                ) ||
                vinElement?.closest(
                    '.SearchResultsDetailView__details_row'
                ) ||
                vinElement?.parentElement;

            results.set(vin, {
                vin,
                vinElement,
                titleElement:
                    findManheimTitle(
                        resolvedCard,
                        vinElement
                    ),
                card: resolvedCard,
                score
            });
        }

        document
            .querySelectorAll(
                'a[href*="#/details/"]'
            )
            .forEach(link => {
                const href =
                    link.getAttribute('href') || '';

                const match =
                    href.match(
                        /#\/details\/([A-HJ-NPR-Z0-9]{17})(?:\/|$)/i
                    );

                if (!match) return;

                const vin =
                    match[1].toUpperCase();

                if (!validVin(vin)) return;

                const card =
                    link.closest(
                        '.SearchResultsDetailView__card-styles'
                    ) ||
                    link.closest(
                        '.SearchResultsDetailView__details_row'
                    ) ||
                    link.parentElement;

                if (!card) return;

                const shortVin =
                    vin.slice(-8);

                const vinElement =
                    [...card.querySelectorAll('*')]
                        .find(element =>
                            element.children.length <= 1 &&
                            element.textContent
                                ?.trim()
                                .toUpperCase() ===
                                vin
                        ) ||
                    [...card.querySelectorAll('*')]
                        .find(element =>
                            element.children.length <= 1 &&
                            element.textContent
                                ?.trim()
                                .toUpperCase() ===
                                shortVin
                        ) ||
                    link;

                addOccurrence(
                    vin,
                    vinElement,
                    card
                );
            });

        document
            .querySelectorAll('body *')
            .forEach(element => {
                if (
                    element.children.length > 2
                ) {
                    return;
                }

                const text =
                    element.textContent
                        ?.trim()
                        .toUpperCase() || '';

                if (
                    !text ||
                    text.length > 220
                ) {
                    return;
                }

                const vins =
                    text.match(VIN_REGEX);

                if (!vins) return;

                vins.forEach(vin => {
                    addOccurrence(
                        vin,
                        element
                    );
                });
            });

        const currentUrlVin =
            location.href.match(
                /#\/details\/([A-HJ-NPR-Z0-9]{17})(?:\/|$)/i
            )?.[1];

        if (
            currentUrlVin &&
            !results.has(
                currentUrlVin.toUpperCase()
            )
        ) {
            const vin =
                currentUrlVin.toUpperCase();

            const visibleVinElement =
                [...document.querySelectorAll(
                    'body *'
                )].find(element =>
                    element.children.length <= 1 &&
                    element.textContent
                        ?.toUpperCase()
                        .includes(vin)
                );

            if (visibleVinElement) {
                addOccurrence(
                    vin,
                    visibleVinElement
                );
            }
        }

        return [...results.values()]
            .map(({ score, ...item }) =>
                item
            );
    }

    function findCopartLotOccurrences() {
        const results = new Map();

        function findCopartVinElement(root) {
            const vinPattern =
                /(?:VIN\s*:\s*)?([A-HJ-NPR-Z0-9]{17})/i;

            return [...root.querySelectorAll('*')]
                .filter(element =>
                    element.children.length <= 1
                )
                .map(element => ({
                    element,
                    match:
                        element.textContent
                            ?.replace(/\s+/g, ' ')
                            .trim()
                            .match(vinPattern)
                }))
                .find(item =>
                    item.match &&
                    item.element.textContent
                        ?.toUpperCase()
                        .includes('VIN')
                ) ||
                [...root.querySelectorAll('*')]
                    .filter(element =>
                        element.children.length <= 1
                    )
                    .map(element => ({
                        element,
                        match:
                            element.textContent
                                ?.replace(/\s+/g, ' ')
                                .trim()
                                .match(vinPattern)
                    }))
                    .find(item => item.match) ||
                null;
        }

        function addLot(
            lot,
            sourceElement
        ) {
            if (!/^\d{6,12}$/.test(lot)) {
                return;
            }

            if (results.has(lot)) return;

            const card =
                sourceElement?.closest('tr') ||
                sourceElement?.closest(
                    '#lot-details-page'
                ) ||
                sourceElement?.parentElement ||
                document.body;

            const lotLinks =
                [...card.querySelectorAll(
                    'a[href*="/lot/"]'
                )];

            const titleElement =
                card.querySelector('h1') ||
                lotLinks.find(element => {
                    const text =
                        element.textContent
                            ?.trim() || '';

                    return (
                        text.length >= 8 &&
                        !/^\d+$/.test(text) &&
                        TITLE_REGEX.test(text)
                    );
                }) ||
                null;

            const lotElement =
                lotLinks.find(element =>
                    element.textContent
                        ?.trim() === lot
                ) ||
                [...card.querySelectorAll('*')]
                    .find(element => {
                        if (
                            element.children.length > 1
                        ) {
                            return false;
                        }

                        const text =
                            element.textContent
                                ?.replace(/\s+/g, '') || '';

                        return (
                            text === lot ||
                            text ===
                                `Lotnumber:${lot}`
                        );
                    }) ||
                sourceElement;

            const copartVin =
                findCopartVinElement(card);

            const markerElement =
                copartVin?.element ||
                lotElement;

            results.set(lot, {
                vin: `LOT:${lot}`,
                vinElement: markerElement,
                titleElement,
                card,
                copartVin:
                    copartVin?.match?.[1]
                        ?.toUpperCase() || null
            });
        }

        document
            .querySelectorAll(
                'a[href*="/lot/"]'
            )
            .forEach(link => {
                const href =
                    link.getAttribute('href') || '';

                const lot =
                    href.match(
                        /\/lot\/(\d{6,12})(?:\/|$)/
                    )?.[1];

                if (lot) {
                    addLot(lot, link);
                }
            });

        const currentLot =
            location.pathname.match(
                /\/lot\/(\d{6,12})(?:\/|$)/
            )?.[1];

        if (currentLot) {
            addLot(
                currentLot,
                document.querySelector(
                    '#lot-details-page'
                ) || document.body
            );
        }

        return [...results.values()];
    }

    function findAllVinOccurrences() {
        if (SITE === 'copart') {
            return findCopartLotOccurrences();
        }

        if (SITE === 'manheim') {
            return findManheimVinOccurrences();
        }

        const results = [];

        document
            .querySelectorAll('body *')
            .forEach(element => {
                if (
                    element.children.length > 3
                ) {
                    return;
                }

                const text =
                    element.textContent
                        ?.trim() || '';

                if (
                    !text ||
                    text.length > 180
                ) {
                    return;
                }

                const vins =
                    text.match(VIN_REGEX);

                if (!vins) return;

                vins.forEach(vin => {
                    const card =
                        findVehicleCard(
                            element,
                            vin
                        );

                    results.push({
                        vin,
                        vinElement:
                            element,

                        titleElement:
                            findTitleElement(
                                card,
                                element
                            ),
                        card
                    });
                });
            });

        return results;
    }

    /* ========================================
       COLORS
    ======================================== */

    function vinColor(vin) {
        const seenByVlad =
            vladVins.has(vin);

        const seenByWorker =
            workerVins.has(vin);

        if (
            seenByVlad &&
            seenByWorker
        ) {
            return COLORS.both;
        }

        if (seenByVlad) {
            return COLORS.vlad;
        }

        if (seenByWorker) {
            return COLORS.worker;
        }

        return null;
    }

    function occurrenceIdentifiers(item) {
        const identifiers = [item.vin];

        if (
            SITE === 'copart' &&
            validVin(item.copartVin)
        ) {
            identifiers.push(item.copartVin);
        }

        return [...new Set(identifiers)];
    }

    function occurrenceColor(item) {
        const identifiers =
            occurrenceIdentifiers(item);

        const appearsInDaily = (set, identifier) =>
            [...set].some(mark => mark.endsWith(`|${identifier}`));

        const seenByVlad =
            identifiers.some(identifier =>
                vladVins.has(identifier) ||
                appearsInDaily(dailyVladMarks, identifier)
            );

        const seenByWorker =
            identifiers.some(identifier =>
                workerVins.has(identifier) ||
                appearsInDaily(dailyWorkerMarks, identifier)
            );

        if (seenByVlad && seenByWorker) {
            return COLORS.both;
        }

        if (seenByVlad) return COLORS.vlad;
        if (seenByWorker) return COLORS.worker;
        return null;
    }

    function applyMarkedFilter(occurrences) {
        if (hideMode === 'show') {
            filteredCards.forEach(card => {
                card?.classList?.remove('vin-marker-filter-hidden');
            });
            filteredCards.clear();
            return;
        }

        const isDetailPage =
            (SITE === 'manheim' && location.hash.includes('/details/')) ||
            (SITE === 'ove' && location.hash.includes('/details/')) ||
            (SITE === 'copart' && /\/lot\/\d+/i.test(location.pathname));

        if (isDetailPage) {
            filteredCards.forEach(card => {
                card?.classList?.remove('vin-marker-filter-hidden');
            });
            filteredCards.clear();
            return;
        }

        const nextFilteredCards = new Set();

        const dailyContains = (set, identifier) =>
            [...set].some(mark => mark.endsWith(`|${identifier}`));

        occurrences.forEach(item => {
            const identifiers = occurrenceIdentifiers(item);
            const seenByVlad = identifiers.some(identifier =>
                vladVins.has(identifier) || dailyContains(dailyVladMarks, identifier)
            );
            const seenByWorker = identifiers.some(identifier =>
                workerVins.has(identifier) || dailyContains(dailyWorkerMarks, identifier)
            );
            const shouldHide = hideMode === 'all'
                ? seenByVlad || seenByWorker
                : activeUser === VLAD
                    ? seenByVlad
                    : activeUser === WORKER && seenByWorker;
            const card = item.card;

            if (
                shouldHide &&
                card &&
                card !== document.body &&
                card !== document.documentElement
            ) {
                nextFilteredCards.add(card);
            }
        });

        filteredCards.forEach(card => {
            if (!nextFilteredCards.has(card)) {
                card?.classList?.remove('vin-marker-filter-hidden');
            }
        });

        nextFilteredCards.forEach(card => {
            if (!filteredCards.has(card)) {
                card.classList.add('vin-marker-filter-hidden');
            }
        });

        filteredCards.clear();
        nextFilteredCards.forEach(card => filteredCards.add(card));
    }

    function linkCopartVinAndLot(occurrences) {
        if (SITE !== 'copart') return false;

        let changed = false;

        occurrences.forEach(item => {
            const identifiers =
                occurrenceIdentifiers(item);

            if (identifiers.length < 2) return;

            [vladVins, workerVins]
                .forEach(set => {
                    if (
                        !identifiers.some(identifier =>
                            set.has(identifier)
                        )
                    ) {
                        return;
                    }

                    identifiers.forEach(identifier => {
                        if (!set.has(identifier)) {
                            set.add(identifier);
                            changed = true;
                        }
                    });
                });
        });

        if (changed) {
            saveLocalVinState();

            clearTimeout(copartAutoSyncTimer);
            copartAutoSyncTimer = setTimeout(
                () => synchronize(true),
                750
            );
        }

        return changed;
    }

    function colorElement(
        element,
        color
    ) {
        if (!element || !color) return;

        if (!paintedElementStyles.has(element)) {
            paintedElementStyles.set(element, {
                color: element.style.getPropertyValue('color'),
                colorPriority: element.style.getPropertyPriority('color'),
                weight: element.style.getPropertyValue('font-weight'),
                weightPriority: element.style.getPropertyPriority('font-weight')
            });
        }

        element.style.setProperty(
            'color',
            color,
            'important'
        );

        element.style.setProperty(
            'font-weight',
            '800',
            'important'
        );
    }

    function colorTextTree(
        element,
        color
    ) {
        if (!element || !color) return;

        colorElement(
            element,
            color
        );

        element
            .querySelectorAll('*')
            .forEach(child => {
                const text =
                    child.textContent
                        ?.trim() || '';

                if (!text) return;

                colorElement(
                    child,
                    color
                );
            });
    }

    function colorManheimVehicleTitle(card, fallback, color) {
        const candidates = card
            ? [...card.querySelectorAll('a, h1, h2, h3, h4, [role="heading"]')]
            : [];

        const titles = candidates.filter(element => {
            const text = element.textContent?.replace(/\s+/g, ' ').trim() || '';
            return (
                text.length >= 8 &&
                text.length <= 190 &&
                /\b(?:19|20)\d{2}\s+[A-Z0-9]/i.test(text) &&
                !/Provided\s*:/i.test(text) &&
                !text.match(VIN_REGEX)
            );
        });

        if (titles.length) {
            titles.forEach(element => colorTextTree(element, color));
            return;
        }

        const fallbackText = fallback?.textContent?.trim() || '';
        if (fallback && !/Provided\s*:/i.test(fallbackText)) {
            colorTextTree(fallback, color);
        }
    }

    function paintSeenVins() {
        refreshSharedVinState();

        paintedElementStyles.forEach((original, element) => {
            if (original.color) {
                element.style.setProperty('color', original.color, original.colorPriority);
            } else {
                element.style.removeProperty('color');
            }

            if (original.weight) {
                element.style.setProperty('font-weight', original.weight, original.weightPriority);
            } else {
                element.style.removeProperty('font-weight');
            }
        });
        paintedElementStyles.clear();

        const occurrences =
            findAllVinOccurrences();

        linkCopartVinAndLot(occurrences);

        occurrences
            .forEach(
                item => {
                    const {
                        vin,
                        vinElement,
                        titleElement
                    } = item;

                    const color =
                        occurrenceColor(item);

                    if (!color) return;

                    colorElement(
                        vinElement,
                        color
                    );

                    if (vinElement) {
                        vinElement
                            .querySelectorAll('*')
                            .forEach(element => {
                                const text =
                                    element.textContent
                                        ?.trim()
                                        .toUpperCase() || '';

                                if (
                                    text &&
                                    (
                                        vin.includes(text) ||
                                        text.includes(vin)
                                    )
                                ) {
                                    colorElement(
                                        element,
                                        color
                                    );
                                }
                            });
                    }

                    if (SITE === 'manheim') {
                        colorManheimVehicleTitle(item.card, titleElement, color);
                    } else {
                        colorTextTree(
                            titleElement,
                            color
                        );
                    }
                }
            );

        applyMarkedFilter(occurrences);

        updateCounter();
    }

    /* ========================================
       MARK CURRENT PAGE
    ======================================== */

    async function markPage(
        user,
        button
    ) {
        const occurrences =
            findAllVinOccurrences();

        const vins =
            [...new Set(
                occurrences.flatMap(
                    occurrenceIdentifiers
                )
            )];

        const targetSet =
            user === VLAD
                ? vladVins
                : workerVins;

        const newlyAdded =
            vins.filter(
                vin =>
                    !targetSet.has(vin)
            );

        newlyAdded.forEach(vin => {
            targetSet.add(vin);
        });

        const dailySet = user === VLAD ? dailyVladMarks : dailyWorkerMarks;
        newlyAdded.forEach(vin => dailySet.add(`${todayKey()}|${vin}`));

        if (newlyAdded.length) {
            saveDailyMarks();
        }

        saveLocalVinState();
        paintSeenVins();

        const originalText =
            button.textContent;

        button.textContent = newlyAdded.length
            ? `MARKED ${newlyAdded.length}`
            : 'ALREADY MARKED';

        if (!newlyAdded.length) {
            cloudStatus = 'VIN ALREADY MARKED';
            updateCounter();

            setTimeout(() => {
                updateCounter();
            }, 1400);

            return;
        }

        cloudStatus = 'UPLOADING...';
        updateCounter();

        try {
            await appendVinsToCloud(
                user,
                newlyAdded,
                newlyAdded
            );

            cloudStatus = 'CLOUD SYNCED';

        } catch (error) {
            console.error(
                `${SITE_LABEL} upload error:`,
                error
            );

            cloudStatus =
                'ERROR: ' +
                formatError(error);
        }

        updateCounter();

        setTimeout(() => {
            button.textContent =
                originalText;
        }, 2000);
    }

    /* ========================================
       CLEAR
    ======================================== */

    async function clearEverything() {
        const confirmed = confirm(
            SITE === 'copart'
                ? 'Delete ALL Vlad and Worker Copart Lot history from every device?'
                : 'Delete ALL Vlad and Worker VIN history from every device?'
        );

        if (!confirmed) return;

        clearButton.disabled = true;
        clearButton.textContent =
            'CLEARING...';

        try {
            await replaceCloudState(
                [],
                []
            );

            vladVins.clear();
            workerVins.clear();

            GM_setValue(
                SHARED_VIN_STORAGE,
                JSON.stringify({
                    vlad: [],
                    worker: []
                })
            );

            if (SITE === 'copart') {
                GM_setValue(
                    SHARED_VIN_MIGRATION,
                    true
                );
            } else {
                GM_setValue(
                    'ove_manheim_migrated_ove_v5',
                    true
                );

                GM_setValue(
                    'ove_manheim_migrated_manheim_v5',
                    true
                );
            }

            localStorage.removeItem(
                OLD_VIN_STORAGE
            );

            localStorage.removeItem(
                LOCAL_STATE_STORAGE
            );

            localStorage.setItem(
                MIGRATION_STORAGE,
                'true'
            );

            location.reload();

        } catch (error) {
            console.error(
                'Clear error:',
                error
            );

            alert(
                'Could not clear cloud history: ' +
                formatError(error)
            );

            clearButton.disabled = false;
            clearButton.textContent =
                'CLEAR';
        }
    }

    /* ========================================
       PANEL
    ======================================== */

    const panel =
        document.createElement('div');

    panel.id = 'ove-vin-marker-source';

    Object.assign(panel.style, {
        position: 'fixed',
        top: '85px',
        right: '20px',
        zIndex: '2147483647',

        width: '510px',
        minWidth: '300px',
        maxWidth: '95vw',

        background: '#ffffff',
        borderRadius: '10px',

        boxShadow:
            '0 4px 18px rgba(0,0,0,.35)',

        overflow: 'hidden',
        resize: 'both'
    });

    const handle =
        document.createElement('div');

    Object.assign(handle.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent:
            'space-between',

        padding: '7px 9px',

        background: '#242424',
        color: '#ffffff',

        fontSize: '12px',
        fontWeight: '800',

        cursor: 'move',
        userSelect: 'none'
    });

    const handleTitle =
        document.createElement('div');

    handleTitle.textContent =
        `⋮⋮ ${SITE_LABEL} VIN MARKER`;

    const sizeControls =
        document.createElement('div');

    Object.assign(
        sizeControls.style,
        {
            display: 'flex',
            gap: '5px'
        }
    );

    const smallerButton =
        document.createElement('button');

    smallerButton.textContent = '−';

    const largerButton =
        document.createElement('button');

    largerButton.textContent = '+';

    [
        smallerButton,
        largerButton
    ].forEach(button => {
        Object.assign(button.style, {
            width: '27px',
            height: '24px',
            padding: '0',

            border: 'none',
            borderRadius: '5px',

            background: '#ffffff',
            color: '#222222',

            fontSize: '17px',
            fontWeight: '900',
            cursor: 'pointer'
        });
    });

    sizeControls.append(
        smallerButton,
        largerButton
    );

    handle.append(
        handleTitle,
        sizeControls
    );

    const content =
        document.createElement('div');

    content.id = 'ove-vin-marker-content';

    Object.assign(content.style, {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',

        gap: '7px',
        padding: '9px'
    });

    const infoBox =
        document.createElement('div');

    Object.assign(infoBox.style, {
        position: 'relative',
        flexGrow: '1',
        minWidth: '150px',

        padding: '7px 10px',

        background: '#f3f3f3',
        borderRadius: '7px',

        fontWeight: '800',
        lineHeight: '1.25'
    });

    const counter =
        document.createElement('div');

    const accountRow = document.createElement('div');
    accountRow.id = 'vin-marker-account-row';
    Object.assign(accountRow.style, {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
        marginBottom: '6px', paddingBottom: '6px', borderBottom: '1px solid #dddddd', fontSize: '11px'
    });
    const accountLabel = document.createElement('span');
    accountLabel.textContent = 'LOGGED IN AS';
    const accountSelect = document.createElement('select');
    accountSelect.innerHTML = '<option value="">Log in</option><option value="vlad">Vlad</option><option value="worker">Vadim</option>';
    accountSelect.value = activeUser;
    Object.assign(accountSelect.style, {
        border: '1px solid #ccd3dc', borderRadius: '6px', background: '#ffffff',
        padding: '4px 7px', fontWeight: '800', cursor: 'pointer'
    });
    accountRow.append(accountLabel, accountSelect);

    const status =
        document.createElement('div');

    const statsButton = document.createElement('button');
    statsButton.className = 'marker-stats-button';
    statsButton.textContent = '📊';
    statsButton.title = 'Show all-time statistics';
    Object.assign(statsButton.style, {
        position: 'absolute', top: '6px', right: '7px', width: '28px', height: '25px',
        padding: '0', border: 'none', borderRadius: '6px', background: '#ffffff', cursor: 'pointer'
    });
    counter.style.paddingRight = '32px';

    Object.assign(status.style, {
        marginTop: '3px',
        fontSize: '11px',
        fontWeight: '800'
    });

    infoBox.append(
        accountRow,
        counter,
        status,
        statsButton
    );

    function createButton(
        text,
        background
    ) {
        const button =
            document.createElement('button');

        button.textContent = text;

        Object.assign(button.style, {
            padding: '11px 14px',

            border: 'none',
            borderRadius: '8px',

            background,
            color: '#ffffff',

            fontWeight: '900',
            cursor: 'pointer',
            whiteSpace: 'nowrap'
        });

        return button;
    }

    const vladButton =
        createButton(
            'MARK',
            COLORS.vlad
        );

    const syncButton =
        createButton(
            'SYNC',
            '#2864eb'
        );

    const hideSelect = document.createElement('select');
    hideSelect.title = 'Filter marked listings';
    hideSelect.innerHTML = '<option value="show">SHOW ALL</option><option value="mine">HIDE MINE</option><option value="all">HIDE MARKED</option>';
    hideSelect.value = hideMode;
    Object.assign(hideSelect.style, {
        minWidth: '0', padding: '10px 7px', border: '1px solid #ccd4df',
        borderRadius: '8px', background: '#ffffff', color: '#465365',
        fontWeight: '900', fontSize: '11px', cursor: 'pointer'
    });

    const clearButton =
        createButton(
            'CLEAR',
            '#555555'
        );

    content.append(
        infoBox,
        vladButton,
        hideSelect,
        syncButton
    );

    panel.append(
        handle,
        content
    );

    document.body.appendChild(panel);

    /* ========================================
       PANEL STATUS
    ======================================== */

    function updateCounter() {
        const allVins =
            new Set([
                ...vladVins,
                ...workerVins
            ]);

        let both = 0;

        allVins.forEach(vin => {
            if (
                vladVins.has(vin) &&
                workerVins.has(vin)
            ) {
                both++;
            }
        });

        const itemLabel =
            SITE === 'copart'
                ? 'Lots'
                : 'VINs';

        const countableIdentifiers =
            SITE === 'copart'
                ? [...allVins].filter(identifier =>
                    identifier.startsWith('LOT:')
                )
                : [...allVins];

        const countFor = set =>
            SITE === 'copart'
                ? [...set].filter(identifier =>
                    identifier.startsWith('LOT:')
                ).length
                : set.size;

        if (SITE === 'copart') {
            both = countableIdentifiers
                .filter(identifier =>
                    vladVins.has(identifier) &&
                    workerVins.has(identifier)
                ).length;
        }

        const prefix = `${todayKey()}|`;
        const todayIdentifiers = set => [...set]
            .filter(value => value.startsWith(prefix))
            .map(value => value.slice(prefix.length))
            .filter(identifier => SITE !== 'copart' || identifier.startsWith('LOT:'));
        const todayVlad = new Set(todayIdentifiers(dailyVladMarks));
        const todayWorker = new Set(todayIdentifiers(dailyWorkerMarks));
        const todayAll = new Set([...todayVlad, ...todayWorker]);
        const todayBoth = [...todayAll].filter(identifier => todayVlad.has(identifier) && todayWorker.has(identifier)).length;

        counter.textContent = statsMode === 'today'
            ? `TODAY — ${itemLabel}: ${todayAll.size} | Vlad: ${todayVlad.size} | Vadim: ${todayWorker.size} | Both: ${todayBoth}`
            : `ALL TIME — ${itemLabel}: ${countableIdentifiers.length} | Vlad: ${countFor(vladVins)} | Vadim: ${countFor(workerVins)} | Both: ${both}`;

        statsButton.textContent = statsMode === 'today' ? '📊' : '↩';
        statsButton.title = statsMode === 'today' ? 'Show all-time statistics' : 'Back to today';
        vladButton.textContent = activeUser ? `MARK · ${activeUser === VLAD ? 'VLAD' : 'VADIM'}` : 'LOG IN';
        vladButton.style.background = activeUser === WORKER ? COLORS.worker : COLORS.vlad;

        status.textContent =
            cloudStatus;

        if (
            cloudStatus ===
            'CLOUD SYNCED'
        ) {
            status.style.color =
                COLORS.vlad;

        } else if (
            cloudStatus.startsWith(
                'ERROR'
            )
        ) {
            status.style.color =
                COLORS.both;

        } else {
            status.style.color =
                '#555555';
        }
    }

    /* ========================================
       MOVE AND RESIZE PANEL
    ======================================== */

    let panelScale = 1;
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    function restorePanel() {
        const saved =
            loadJson(
                PANEL_STORAGE,
                {}
            );

        if (
            Number.isFinite(saved.left) &&
            Number.isFinite(saved.top)
        ) {
            panel.style.left =
                `${saved.left}px`;

            panel.style.top =
                `${saved.top}px`;

            panel.style.right = 'auto';
        }

        if (
            Number.isFinite(saved.width)
        ) {
            panel.style.width =
                `${saved.width}px`;
        }

        if (
            Number.isFinite(saved.height)
        ) {
            panel.style.height =
                `${saved.height}px`;
        }

        if (
            Number.isFinite(saved.scale)
        ) {
            panelScale =
                Math.max(
                    0.6,
                    Math.min(
                        1.6,
                        saved.scale
                    )
                );

            panel.style.zoom =
                String(panelScale);
        }
    }

    function savePanel() {
        const rect =
            panel.getBoundingClientRect();

        saveJson(
            PANEL_STORAGE,
            {
                left:
                    parseFloat(
                        panel.style.left
                    ) || rect.left,

                top:
                    parseFloat(
                        panel.style.top
                    ) || rect.top,

                width:
                    panel.offsetWidth,

                height:
                    panel.offsetHeight,

                scale:
                    panelScale
            }
        );
    }

    function ensurePanelVisible() {
        const rect =
            panel.getBoundingClientRect();

        const maxLeft =
            Math.max(
                0,
                window.innerWidth -
                    Math.min(rect.width, window.innerWidth)
            );

        const maxTop =
            Math.max(
                0,
                window.innerHeight - 35
            );

        const left =
            Math.max(
                0,
                Math.min(rect.left, maxLeft)
            );

        const top =
            Math.max(
                0,
                Math.min(rect.top, maxTop)
            );

        if (
            left !== rect.left ||
            top !== rect.top
        ) {
            panel.style.left =
                `${left}px`;

            panel.style.top =
                `${top}px`;

            panel.style.right = 'auto';
            savePanel();
        }
    }

    restorePanel();

    requestAnimationFrame(
        ensurePanelVisible
    );

    window.addEventListener(
        'resize',
        ensurePanelVisible
    );

    try {
        GM_addValueChangeListener(
            SHARED_VIN_STORAGE,
            (
                _name,
                _oldValue,
                _newValue,
                remote
            ) => {
                refreshSharedVinState();
                paintSeenVins();

                if (remote) {
                    cloudStatus =
                        'UPDATED FROM OVE/MANHEIM';

                    updateCounter();
                }
            }
        );

        GM_addValueChangeListener(
            DAILY_STORAGE,
            () => {
                loadDailyMarks();
                paintSeenVins();
                updateCounter();
            }
        );
    } catch (_) {}

    handle.addEventListener(
        'pointerdown',
        event => {
            if (
                event.target ===
                    smallerButton ||
                event.target ===
                    largerButton
            ) {
                return;
            }

            dragging = true;

            const rect =
                panel.getBoundingClientRect();

            offsetX =
                event.clientX - rect.left;

            offsetY =
                event.clientY - rect.top;

            handle.setPointerCapture(
                event.pointerId
            );

            event.preventDefault();
        }
    );

    handle.addEventListener(
        'pointermove',
        event => {
            if (!dragging) return;

            const rect =
                panel.getBoundingClientRect();

            const left =
                Math.max(
                    0,
                    Math.min(
                        event.clientX -
                            offsetX,
                        window.innerWidth -
                            rect.width
                    )
                );

            const top =
                Math.max(
                    0,
                    Math.min(
                        event.clientY -
                            offsetY,
                        window.innerHeight -
                            35
                    )
                );

            panel.style.left =
                `${left}px`;

            panel.style.top =
                `${top}px`;

            panel.style.right = 'auto';
        }
    );

    handle.addEventListener(
        'pointerup',
        event => {
            dragging = false;

            try {
                handle.releasePointerCapture(
                    event.pointerId
                );
            } catch (_) {}

            savePanel();
        }
    );

    smallerButton.addEventListener(
        'click',
        event => {
            event.stopPropagation();

            panelScale =
                Math.max(
                    0.6,
                    panelScale - 0.1
                );

            panel.style.zoom =
                String(panelScale);

            ensurePanelVisible();
            savePanel();
        }
    );

    largerButton.addEventListener(
        'click',
        event => {
            event.stopPropagation();

            panelScale =
                Math.min(
                    1.6,
                    panelScale + 0.1
                );

            panel.style.zoom =
                String(panelScale);

            ensurePanelVisible();
            savePanel();
        }
    );

    if (
        typeof ResizeObserver !==
        'undefined'
    ) {
        let resizeTimer;

        const resizeObserver =
            new ResizeObserver(() => {
                clearTimeout(
                    resizeTimer
                );

                resizeTimer =
                    setTimeout(
                        savePanel,
                        350
                    );
            });

        resizeObserver.observe(panel);
    }

    /* ========================================
       BUTTON EVENTS
    ======================================== */

    vladButton.addEventListener(
        'click',
        () => {
            if (!activeUser) {
                accountSelect.focus();
                alert('Choose Vlad or Vadim first.');
                return;
            }
            markPage(
                activeUser,
                vladButton
            );
        }
    );

    accountSelect.addEventListener('change', () => {
        activeUser = accountSelect.value;
        GM_setValue(ACTIVE_USER_STORAGE, activeUser);
        paintSeenVins();
        updateCounter();
    });

    hideSelect.addEventListener('change', () => {
        hideMode = hideSelect.value;

        if (hideMode === 'show') {
            filteredCards.forEach(card => {
                card?.classList?.remove('vin-marker-filter-hidden');
            });
            filteredCards.clear();
            return;
        }

        paintSeenVins();
    });

    syncButton.addEventListener(
        'click',
        () => {
            synchronize(true);
        }
    );

    statsButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        statsMode = statsMode === 'today' ? 'all' : 'today';
        updateCounter();
    });

    /* ========================================
       START
    ======================================== */

    updateCounter();
    paintSeenVins();

    window.addEventListener(
        'storage',
        event => {
            if (
                event.key !==
                LOCAL_STATE_STORAGE
            ) {
                return;
            }

            loadLocalVinState();
            paintSeenVins();

            cloudStatus =
                'UPDATED FROM ANOTHER TAB';

            updateCounter();
        }
    );

    setTimeout(
        () => {
            synchronize(true);
        },
        1500
    );

    let mutationTimer;

    const observer =
        new MutationObserver(() => {
            clearTimeout(
                mutationTimer
            );

            mutationTimer =
                setTimeout(
                    paintSeenVins,
                    350
                );
        });

    observer.observe(
        document.body,
        {
            childList: true,
            subtree: true
        }
    );

    setInterval(
        () => {
            synchronize(false);
        },
        AUTO_SYNC_INTERVAL
    );

})();

(function () {
  'use strict';
  const HOST = location.hostname.toLowerCase();
  const SCRIPT_VERSION = '2.2.3';
  const UPDATE_MANIFEST_URL =
    'https://raw.githubusercontent.com/vladrusakov08-code/auction-assistant-updates/main/latest.json';
  const UPDATE_SCRIPT_URL =
    'https://raw.githubusercontent.com/vladrusakov08-code/auction-assistant-updates/main/ove-auction-assistant.user.js';
  const UPDATE_CHECK_STORAGE = 'auction_assistant_update_check_v1';
  let availableUpdate = null;
  let updateCheckStarted = false;
  const IS_SUPPORTED_AUCTION = HOST.includes('ove.com') || HOST.includes('manheim.com') || HOST.includes('copart.com');
  const AUCTION_SITE = HOST.includes('copart') ? 'COPART' : HOST.includes('manheim') ? 'MANHEIM' : HOST.includes('ove.com') ? 'OVE' : 'VEHICLE';
  const BRIDGE = 'http://127.0.0.1:8765';
  const SETTINGS_KEY = 'oveKbbSettings';
  const JOB_KEY = 'oveKbbActiveJob';
  const CARFAX_JOB_KEY = 'oveCarfaxActiveJob';
  const ASSISTANT_UI_KEY = 'oveAuctionAssistantUi';
  const DEAL_SETTINGS_KEY = 'auctionAssistantDealSettings';
  const SHEET_SAVE_SETTINGS_KEY = 'auctionAssistantSheetSaveSettingsV1';
  const SHEET_SAVE_WEB_APP_URL =
    'https://script.google.com/macros/s/AKfycbzx2f63KpLVX9me2jOnlEX3lgp7mWOqq3CkAivoM3_EMOj6ENMrYQcFkoqwedhLBY_-/exec';
  const KBB_QUEUE_FIELD = 'kbbSharedQueueV1';
  const SHARED_RESULTS_FIELD = 'vehicleSharedResultsV1';
  const KBB_QUEUE_DOC = 'https://firestore.googleapis.com/v1/projects/vin-tracker-b1a76/databases/(default)/documents/ove_sync/state';
  const KBB_QUEUE_AUTH_KEY = 'firebase_auth_shared_v3';
  const FIREBASE_API_KEY = 'AIzaSyDdKVdF7Dtpo_8_QhKCpy4usKcV8AAt5rE';
  const MANUAL_VEHICLE_KEY = `auctionAssistantManualVehicle:${HOST}`;
  const DEFAULTS = { zip: '90001' };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let lastRun = 0;
  const kbbJobKey = (vin) => `${JOB_KEY}:${vin}`;

  function queueRequest(method, url, body = null, headers = {}) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method, url, timeout: 25000, headers: { ...headers, ...(body ? { 'Content-Type':'application/json' } : {}) },
      data: body ? JSON.stringify(body) : undefined,
      onload: (response) => {
        let payload = {}; try { payload = response.responseText ? JSON.parse(response.responseText) : {}; } catch (_) {}
        if (response.status >= 200 && response.status < 300) return resolve(payload);
        const error = new Error(payload?.error?.message || `Queue HTTP ${response.status}`);
        error.status = response.status; reject(error);
      },
      onerror: () => reject(new Error('Shared KBB queue network error')),
      ontimeout: () => reject(new Error('Shared KBB queue timed out')),
    }));
  }
  async function queueToken() {
    let auth = GM_getValue(KBB_QUEUE_AUTH_KEY, {}) || {};
    if (auth.idToken && auth.expiresAt > Date.now() + 120000) return auth.idToken;
    let result;
    if (auth.refreshToken) {
      try {
        result = await new Promise((resolve, reject) => GM_xmlhttpRequest({
          method:'POST', url:`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
          timeout:25000, headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
          data:`grant_type=refresh_token&refresh_token=${encodeURIComponent(auth.refreshToken)}`,
          onload:(response) => { try { const value=JSON.parse(response.responseText||'{}'); response.status<300?resolve(value):reject(new Error(value?.error?.message||'Token refresh failed')); } catch(error){reject(error);} },
          onerror:() => reject(new Error('Token refresh network error')),
        }));
      } catch (_) { result = null; }
    }
    if (result?.id_token) auth = { idToken:result.id_token, refreshToken:result.refresh_token || auth.refreshToken,
      userId:result.user_id || auth.userId, expiresAt:Date.now() + Number(result.expires_in || 3600) * 1000 };
    else {
      result = await queueRequest('POST',
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
        { returnSecureToken:true });
      auth = { idToken:result.idToken, refreshToken:result.refreshToken, userId:result.localId,
        expiresAt:Date.now() + Number(result.expiresIn || 3600) * 1000 };
    }
    GM_setValue(KBB_QUEUE_AUTH_KEY, auth); return auth.idToken;
  }
  async function readSharedKbbQueue() {
    const token = await queueToken();
    const document = await queueRequest('GET', KBB_QUEUE_DOC, null, { Authorization:`Bearer ${token}` });
    const raw = document.fields?.[KBB_QUEUE_FIELD]?.stringValue || '';
    let state = {}; try { state = raw ? JSON.parse(raw) : {}; } catch (_) {}
    state.pending = Array.isArray(state.pending) ? state.pending : [];
    state.jobs = state.jobs && typeof state.jobs === 'object' ? state.jobs : {};
    return { state, updateTime:document.updateTime };
  }
  async function writeSharedKbbQueue(state, updateTime) {
    const token = await queueToken();
    state.updatedAt = Date.now();
    const precondition = updateTime ? `&currentDocument.updateTime=${encodeURIComponent(updateTime)}` : '';
    return queueRequest('PATCH', `${KBB_QUEUE_DOC}?updateMask.fieldPaths=${KBB_QUEUE_FIELD}${precondition}`,
      { fields:{ [KBB_QUEUE_FIELD]:{ stringValue:JSON.stringify(state) } } }, { Authorization:`Bearer ${token}` });
  }
  async function mutateSharedKbbQueue(change, attempts = 8) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const { state, updateTime } = await readSharedKbbQueue();
      const value = change(state);
      try { await writeSharedKbbQueue(state, updateTime); return value; }
      catch (error) { if (![409,412].includes(error.status) || attempt === attempts - 1) throw error; await sleep(120 + attempt * 80); }
    }
  }
  async function readSharedResults() {
    const token = await queueToken();
    const document = await queueRequest('GET', KBB_QUEUE_DOC, null, { Authorization:`Bearer ${token}` });
    const raw = document.fields?.[SHARED_RESULTS_FIELD]?.stringValue || '';
    let results = {}; try { results = raw ? JSON.parse(raw) : {}; } catch (_) {}
    return { results:results && typeof results === 'object' ? results : {}, updateTime:document.updateTime };
  }
  async function writeSharedResults(results, updateTime) {
    const token = await queueToken();
    const entries = Object.entries(results)
      .sort((a,b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
      .slice(0, 350);
    const compact = Object.fromEntries(entries);
    const precondition = updateTime ? `&currentDocument.updateTime=${encodeURIComponent(updateTime)}` : '';
    return queueRequest('PATCH', `${KBB_QUEUE_DOC}?updateMask.fieldPaths=${SHARED_RESULTS_FIELD}${precondition}`,
      { fields:{ [SHARED_RESULTS_FIELD]:{ stringValue:JSON.stringify(compact) } } }, { Authorization:`Bearer ${token}` });
  }
  const sharedPublishSignatures = new Map();
  const sharedPublishInFlight = new Set();
  async function publishSharedResult(vin, vehicle = {}) {
    if (!vin) return;
    const kbb = GM_getValue(`oveKbbPrivateResult:${vin}`, null);
    const carfax = GM_getValue(`oveCarfaxResult:${vin}`, null);
    const signature = JSON.stringify({ vehicle, kbb, carfax });
    if (sharedPublishSignatures.get(vin) === signature || sharedPublishInFlight.has(vin)) return;
    sharedPublishInFlight.add(vin);
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const { results, updateTime } = await readSharedResults();
          const old = results[vin] || {};
          results[vin] = {
            ...old,
            vehicle:{ ...(old.vehicle || {}), ...vehicle, vin },
            kbb:kbb || old.kbb || null,
            carfax:carfax || old.carfax || null,
            updatedAt:Date.now(),
          };
          await writeSharedResults(results, updateTime);
          sharedPublishSignatures.set(vin, signature);
          return;
        } catch (error) {
          if (![409,412].includes(error.status) || attempt === 5) return;
          await sleep(100 + attempt * 90);
        }
      }
    } finally {
      sharedPublishInFlight.delete(vin);
    }
  }
  const hydratedSharedVins = new Set();
  async function hydrateSharedResult(vehicle, force = false) {
    if (!vehicle?.vin || (!force && hydratedSharedVins.has(vehicle.vin))) return false;
    hydratedSharedVins.add(vehicle.vin);
    try {
      const { results } = await readSharedResults();
      const shared = results[vehicle.vin];
      if (!shared) return false;
      const localKbb = GM_getValue(`oveKbbPrivateResult:${vehicle.vin}`, null);
      const localCarfax = GM_getValue(`oveCarfaxResult:${vehicle.vin}`, null);
      if (shared.kbb && (!localKbb || Number(shared.updatedAt) >= Number(localKbb.sharedUpdatedAt || 0)))
        GM_setValue(`oveKbbPrivateResult:${vehicle.vin}`, { ...shared.kbb, sharedUpdatedAt:shared.updatedAt });
      if (shared.carfax && (!localCarfax || Number(shared.updatedAt) >= Number(localCarfax.sharedUpdatedAt || 0)))
        GM_setValue(`oveCarfaxResult:${vehicle.vin}`, { ...shared.carfax, sharedUpdatedAt:shared.updatedAt });
      if (shared.sheetRow) GM_setValue(`auctionAssistantSheetSaved:${vehicle.vin}`, { row:shared.sheetRow, savedAt:shared.sheetSavedAt || shared.updatedAt });
      return Boolean(shared.kbb || shared.carfax || shared.sheetRow);
    } catch (_) { return false; }
  }
  async function publishSharedSheetRow(vin, row) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const { results, updateTime } = await readSharedResults();
        results[vin] = { ...(results[vin] || {}), sheetRow:Number(row), sheetSavedAt:Date.now(), updatedAt:Date.now() };
        await writeSharedResults(results, updateTime); return;
      } catch (error) {
        if (![409,412].includes(error.status) || attempt === 5) return;
        await sleep(100 + attempt * 90);
      }
    }
  }
  async function enqueueSharedKbb(vehicle, zip) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
    await mutateSharedKbbQueue((queue) => {
      const requestedBy = GM_getValue('vin_marker_active_profile_v1', '') || 'user';
      const now = Date.now();
      queue.pending = queue.pending.filter((pendingId) => {
        const pendingJob = queue.jobs[pendingId];
        if (!pendingJob || pendingJob.completedAt || pendingJob.requestedBy !== requestedBy) return true;
        pendingJob.status = 'error';
        pendingJob.message = 'Replaced by a newer request';
        pendingJob.completedAt = now;
        pendingJob.updatedAt = now;
        return false;
      });
      const duplicate = [queue.active?.id, ...queue.pending].map(key => queue.jobs[key])
        .find(job => job?.vin === vehicle.vin && !job.completedAt);
      if (duplicate) return;
      queue.jobs[id] = { id, ...vehicle, zip, status:'queued', message:'Waiting in KBB queue',
        requestedBy, createdAt:now, updatedAt:now };
      queue.pending.push(id);
    });
    // If the VIN was already queued in another tab/user, attach this panel to that job.
    const { state } = await readSharedKbbQueue();
    const attached = Object.values(state.jobs).filter(job => job?.vin === vehicle.vin && !job.completedAt)
      .sort((a,b) => a.createdAt - b.createdAt)[0];
    return attached?.id || id;
  }

  function carfaxHtmlToText(html = '') {
    const withImageLabels = html.replace(/<img\b[^>]*\balt=["']([^"']+)["'][^>]*>/gi, ' $1 ');
    const spaced = withImageLabels.replace(/<[^>]+>/g, ' ');
    return new DOMParser().parseFromString(spaced, 'text/html').documentElement?.textContent || spaced;
  }

  function setReactValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function extractReportIcon(rawHtml, patterns, baseUrl = '') {
    if (!rawHtml) return '';
    try {
      const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
      const nodes = [...doc.querySelectorAll('div,li,section,tr,td,p,span')]
        .filter(node => {
          const text = node.textContent?.replace(/\s+/g, ' ').trim() || '';
          return text.length > 0 && text.length < 260 && patterns.some(pattern => pattern.test(text));
        });
      for (const node of nodes) {
        let container = node;
        for (let depth = 0; depth < 4 && container; depth++, container = container.parentElement) {
          const image = [...container.querySelectorAll('img[src]')].find(img => {
            const identity = `${img.getAttribute('src') || ''} ${img.alt || ''} ${img.className || ''}`;
            const width = Number(img.getAttribute('width') || 0);
            const height = Number(img.getAttribute('height') || 0);
            const iconLike = /(?:icon|owner|accident|damage|check|history|total.?loss)/i.test(identity) ||
              (width > 0 && height > 0 && width <= 100 && height <= 100);
            return iconLike && !/(?:logo|advert|banner|carfox)/i.test(identity);
          });
          if (image) return new URL(image.getAttribute('src'), baseUrl || location.href).href;
        }
      }
    } catch (_) {}
    return '';
  }
  function saveCarfaxText(rawText, explicitReportUrl = '', rawHtml = '') {
    const pending = GM_getValue(CARFAX_JOB_KEY, null);
    if (!pending || pending.completedAt || Date.now() - pending.startedAt > 5 * 60 * 1000) return false;
    const text = (rawText || '').replace(/\s+/g, ' ');
    if (!text.includes('CARFAX Report')) return false;
    const summaryText = text;
    const vin = text.match(/VIN:\s*([A-HJ-NPR-Z0-9]{17})/i)?.[1]?.toUpperCase();
    if (!vin || vin !== pending.vin) return false;
    const ownerMatches = [...summaryText.matchAll(/(\d+)\s*(?:Previous\s+)?Owners?/gi)]
      .map(match => Number(match[1]))
      .filter(value => Number.isFinite(value) && value > 0 && value < 20);
    const owners = ownerMatches.length ? Math.max(...ownerMatches) : null;
    const accidentMatch = summaryText.match(/(\d+)\s+Accidents?(?:\s+or Damage)?\s+Reported/i);
    // The report contains a generic "CARFAX has the most accident & damage
    // information" banner. Never treat that advertisement as vehicle history.
    // An explicit clean-history statement anywhere in the report wins.
    const noAccidents = /\bNO\s+ACCIDENTS?\b/i.test(text) ||
      /\bNO\s+(?:DAMAGE|DAMAGES)\s+REPORTED\b/i.test(text);
    const hasAccidentOrDamage = !noAccidents && (
      Boolean(accidentMatch && Number(accidentMatch[1]) > 0) ||
      /\bACCIDENT\s+(?:REPORTED|RECORDED)\b/i.test(text) ||
      /\bTOTAL\s+LOSS\s+(?:REPORTED|RECORDED)\b/i.test(text) ||
      /(?:Minor|Moderate|Severe)(?:\s+to\s+(?:Minor|Moderate|Severe))?\s+Damage/i.test(text)
    );
    // A shell/loading page can already contain the VIN, price and generic
    // accident advertising. Wait for an authoritative history status before
    // completing the job, otherwise the UI could label an unknown result as an accident.
    if (!noAccidents && !hasAccidentOrDamage) return false;
    const retailMatch = text.match(/CARFAX\s+(?:Retail\s+)?Value\s*\$([\d,]+)/i) ||
      text.match(/\$([\d,]+)\s*CARFAX\s+Retail\s+Value/i);
    const result = {
      vin, owners,
      accidents: noAccidents ? 0 : (accidentMatch ? Number(accidentMatch[1]) : null),
      accidentType: noAccidents ? 'clean' : hasAccidentOrDamage ? 'reported' : 'history',
      accidentLabel: noAccidents ? 'No Accidents or Damage' :
        (hasAccidentOrDamage ? 'Accident' : 'Check Report'),
      accidentIconUrl: extractReportIcon(rawHtml, [/No Accidents or Damage/i, /Accidents?.*Reported/i, /Damage Reported/i, /Total Loss/i], explicitReportUrl),
      ownerIconUrl: extractReportIcon(rawHtml, [/\d+\s*Previous Owners?/i], explicitReportUrl),
      retailValue: retailMatch ? Number(retailMatch[1].replace(/,/g, '')) : null,
      reportUrl: explicitReportUrl || pending.reportUrl || document.referrer.match(/https:\/\/carfax-app\.vercel\.app\/pro\/report\/[^/?#]+/)?.[0] || '',
      completedAt: Date.now(),
    };
    GM_setValue(`oveCarfaxResult:${vin}`, result);
    GM_setValue(CARFAX_JOB_KEY, { ...pending, ...result, stage: 'CARFAX ready' });
    publishSharedResult(vin, { vin, title:pending.title || '', mileage:pending.mileage || 0, color:pending.color || '' });
    return true;
  }
  function parseCarfaxDocument() { saveCarfaxText(document.body?.innerText || '', '', document.documentElement?.outerHTML || ''); }
  function readCarfaxReportPage(job) {
    if (readCarfaxReportPage.started) return;
    const frame = document.querySelector('iframe[src*="/api/files/"]');
    if (!frame?.src) return;
    readCarfaxReportPage.started = true;
    try {
      const visibleText = frame.contentDocument?.body?.innerText;
      if (visibleText?.includes('CARFAX Report')) { saveCarfaxText(visibleText, location.origin + location.pathname, frame.contentDocument?.documentElement?.outerHTML || ''); return; }
    } catch (_) {}
    GM_xmlhttpRequest({
      method: 'GET', url: frame.src, timeout: 30000,
      onload: (response) => {
        if (response.status < 200 || response.status >= 300) {
          const current = GM_getValue(CARFAX_JOB_KEY, job);
          GM_setValue(CARFAX_JOB_KEY, { ...current, stage: `CARFAX file error ${response.status}` });
          readCarfaxReportPage.started = false;
          return;
        }
        const decoded = carfaxHtmlToText(response.responseText);
        if (!saveCarfaxText(decoded, location.origin + location.pathname, response.responseText)) {
          const current = GM_getValue(CARFAX_JOB_KEY, job);
          GM_setValue(CARFAX_JOB_KEY, { ...current, stage: 'CARFAX report text not recognized' });
          readCarfaxReportPage.started = false;
        }
      },
      onerror: () => { readCarfaxReportPage.started = false; },
      ontimeout: () => { readCarfaxReportPage.started = false; },
    });
  }
  function runCarfaxAutomation() {
    const pending = GM_getValue(CARFAX_JOB_KEY, null);
    if (!pending || pending.completedAt || Date.now() - pending.startedAt > 5 * 60 * 1000) return;
    if (location.pathname.startsWith('/api/files/')) { parseCarfaxDocument(); return; }
    // The partner portal normally opens a completed report in a new foreground tab.
    // Keep that navigation inside our already-background automation tab instead.
    try {
      const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      const originalOpen = pageWindow.open.bind(pageWindow);
      pageWindow.open = (url, target, features) => {
        if (typeof url === 'string' && url.includes('/pro/report/')) { pageWindow.location.href = url; return pageWindow; }
        return originalOpen(url, target, features);
      };
    } catch (_) {}
    let submitted = false;
    const tick = () => {
      const job = GM_getValue(CARFAX_JOB_KEY, null);
      if (!job || job.completedAt || Date.now() - job.startedAt > 5 * 60 * 1000) return;
      if (location.pathname.startsWith('/pro/report/')) {
        const reportUrl = location.origin + location.pathname;
        if (job.reportUrl !== reportUrl) GM_setValue(CARFAX_JOB_KEY, { ...job, reportUrl, stage: 'Reading CARFAX report' });
        readCarfaxReportPage({ ...job, reportUrl });
        return;
      }
      if (location.pathname === '/pro' && !submitted) {
        const input = document.querySelector('#vin');
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Run Report');
        if (input && button) {
          submitted = true;
          setReactValue(input, job.vin);
          setTimeout(() => {
            const current = GM_getValue(CARFAX_JOB_KEY, job);
            if (!button.disabled) {
              GM_setValue(CARFAX_JOB_KEY, { ...current, stage: 'Generating CARFAX report', submittedAt: Date.now() });
              if (button.form) button.form.target = '_self';
              button.click();
            } else submitted = false;
          }, 250);
        }
      }
    };
    tick(); setInterval(tick, 500);
  }
  if (location.hostname === 'carfax-app.vercel.app') return;

  function settings() { return { ...DEFAULTS, ...(GM_getValue(SETTINGS_KEY, {}) || {}) }; }
  function money(value) {
    return value ? Number(value).toLocaleString('en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: 0,
    }) : '—';
  }
  function number(value) { return value ? Number(value).toLocaleString('en-US') : '—'; }
  function miles(value) { return value ? `${Number(value).toLocaleString('en-US')} mi` : '—'; }
  function normalizeColor(value = '') {
    const text = value.toLowerCase().replace(/grey/g, 'gray');
    return ['beige','black','blue','brown','burgundy','gold','gray','green','orange','pink',
      'purple','red','silver','white','yellow'].find((item) => text.includes(item)) || 'white';
  }
  function findVin() {
    const pageText = (document.body?.innerText || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
    const fromUrl = location.href.match(/details\/([A-HJ-NPR-Z0-9]{17})(?:\/|$)/i)?.[1] ||
      location.href.match(/[?&#](?:vin|VIN)=([A-HJ-NPR-Z0-9]{17})(?:&|#|$)/)?.[1] ||
      location.href.match(/\/lot\/(?:\d+\/)?[^/?#]*?([A-HJ-NPR-Z0-9]{17})(?:[/?#]|$)/i)?.[1] || '';
    if (fromUrl) return fromUrl.toUpperCase();
    const detailPage = /(?:#\/details\/|\/details\/|\/lot\/|\/vehicle\/)/i.test(location.href);
    if (IS_SUPPORTED_AUCTION && !detailPage) return '';
    const labeled = pageText.match(/(?:VIN|Vehicle Identification Number)\s*[:#]?\s*([A-HJ-NPR-Z0-9]{17})/i)?.[1] || '';
    if (labeled) return labeled.toUpperCase();
    if (AUCTION_SITE === 'COPART') {
      const vinElement = [...document.querySelectorAll('body *')].find((element) => {
        const ownText = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent || '').join(' ').trim();
        return /\bVIN\s*:/i.test(ownText) || (/\bVIN\s*:/i.test(element.textContent || '') && element.children.length < 6);
      });
      if (vinElement) {
        const afterVin = (vinElement.textContent || '').split(/VIN\s*:/i)[1] || '';
        const compact = afterVin.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
        const candidate = compact.match(/^[A-HJ-NPR-Z0-9]{17}/)?.[0];
        if (candidate) return candidate;
      }
      const looseLabel = pageText.match(/\bVIN\s*:\s*([^\n]{17,40})/i)?.[1] || '';
      const compact = looseLabel.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
      if (/^[A-HJ-NPR-Z0-9]{17}/.test(compact)) return compact.slice(0, 17);
    }
    return (detailPage ? pageText.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i)?.[0] || '' : '').toUpperCase();
  }
  function readMileageFromDom(vin, text) {
    // Auction labels are authoritative. Read them before broad DOM selectors so
    // prices, shipping ZIPs, dates, or mileage from recommendations cannot win.
    const exactLabel = text.match(/(?:Odometer|Mileage|Odo)\s*[:#\-]\s*([\d,]+)(?:\s*(?:mi|miles))?/i)?.[1];
    if (exactLabel !== undefined) return exactLabel;
    if (AUCTION_SITE === 'MANHEIM' && vin) {
      const nearCurrentVin = text.match(new RegExp(`${vin}[\\s\\S]{0,100}?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,7})\\s*(?:mi|miles)(?:[^a-z]|$)`, 'i'))?.[1];
      if (nearCurrentVin !== undefined) return nearCurrentVin;
    }
    if (AUCTION_SITE === 'COPART') {
      const odometerLabel = [...document.querySelectorAll('body *')].find((element) =>
        element.children.length === 0 && /^\s*Odometer\s*:\s*$/i.test(element.textContent || ''));
      const rowText = `${odometerLabel?.parentElement?.innerText || ''} ${odometerLabel?.parentElement?.parentElement?.innerText || ''}`;
      const copartOdo = rowText.match(/Odometer\s*:\s*([\d,]+)/i)?.[1];
      return copartOdo !== undefined ? copartOdo : '';
    }
    const selectors = [
      '[data-testid*="mileage" i]', '[data-test*="mileage" i]', '[class*="mileage" i]',
      '[id*="mileage" i]', '[aria-label*="mileage" i]', '[data-testid*="odometer" i]',
      '[class*="odometer" i]', '[id*="odometer" i]'
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const candidate = `${element.getAttribute('aria-label') || ''} ${element.value || ''} ${element.textContent || ''}`;
        const value = candidate.match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,7})/)?.[1];
        if (value) return value;
      }
    }
    if (vin) {
      const vinNode = [...document.querySelectorAll('body *')].find((element) =>
        element.children.length < 4 && (element.textContent || '').toUpperCase().includes(vin));
      let node = vinNode;
      for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
        const nearby = node.innerText || node.textContent || '';
        const value = nearby.match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})\s*(?:mi|miles)(?:[^a-z]|$)/i)?.[1] ||
          nearby.match(/(?:Mileage|Odometer|Odo)\s*[:#\-]?\s*([\d,]+)/i)?.[1];
        if (value) return value;
      }
    }
    return text.match(/(?:Mileage|Odometer|Odo)\s*[:#\-\n]?\s*([\d,]+)/i)?.[1] ||
      text.match(/(?:^|[^\d])([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})\s*(?:mi|miles)(?:[^a-z]|$)/im)?.[1] || '';
  }
  function readVehicle() {
    const detectedVin = findVin();
    const manual = GM_getValue(MANUAL_VEHICLE_KEY, {}) || {};
    const manualBelongsHere = manual.pageUrl === location.href;
    const vin = detectedVin || (manualBelongsHere ? String(manual.vin || '').toUpperCase() : '');
    if (!vin) return { vin: '', mileage: 0, title: '', color: 'white' };
    const text = document.body?.innerText || '';
    const mmrLink = [...document.querySelectorAll('a[href*="mmr.manheim.com"]')]
      .find((a) => !vin || a.href.includes(`vin=${vin}`));
    let mmr = null;
    try { if (mmrLink) mmr = new URL(mmrLink.href); } catch (_) {}
    const mileageText = mmr?.searchParams.get('mileage') || mmr?.searchParams.get('odometer') ||
      readMileageFromDom(vin, text) ||
      (manualBelongsHere && String(manual.vin || '').toUpperCase() === vin ? String(manual.mileage || '') : '');
    const visibleHeading = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')]
      .find((element) => element.getClientRects().length && /\b(?:19|20)\d{2}\s+[A-Z0-9]/i.test(element.textContent || ''))
      ?.textContent?.trim();
    const title = visibleHeading || text.match(/Provided:\s*([^\n]+)/i)?.[1] ||
      text.match(/\b(?:19|20)\d{2}\s+[A-Z][A-Z0-9 .&'\/-]{3,70}/i)?.[0]?.trim() || (!detectedVin && manual.vin ? 'Manual VIN lookup' : `${AUCTION_SITE} vehicle`);
    const color = normalizeColor(mmr?.searchParams.get('color') ||
      text.match(/Exterior(?: Base)? Color\s*[:\n]?\s*([^\n]+)/i)?.[1] ||
      text.match(/Color\s*[:\n]?\s*(Beige|Black|Blue|Brown|Burgundy|Gold|Gray|Grey|Green|Orange|Pink|Purple|Red|Silver|White|Yellow)/i)?.[1] || '');
    return { vin, mileage: Number(mileageText.replace(/,/g, '')), title, color };
  }
  function bridge(method, data) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method, url: BRIDGE, timeout: 5000,
      headers: { 'Content-Type': 'application/json' },
      data: data ? JSON.stringify(data) : undefined,
      onload: (response) => {
        try { resolve(JSON.parse(response.responseText)); } catch (error) { reject(error); }
      },
      onerror: () => reject(new Error('KBB Bridge is not running')),
      ontimeout: () => reject(new Error('KBB Bridge did not respond')),
    }));
  }
  function sheetSaveSettings() {
    const saved = GM_getValue(SHEET_SAVE_SETTINGS_KEY, {}) || {};
    return { ...saved, webAppUrl:SHEET_SAVE_WEB_APP_URL };
  }
  function readLaneRun() {
    const text = document.body?.innerText || '';
    return text.match(/Lane\s*\/\s*Item\s*[:#-]?\s*([^\n]+)/i)?.[1]?.trim() ||
      text.match(/Lane\s*\/\s*Run\s*[:#-]?\s*([^\n]+)/i)?.[1]?.trim() || '';
  }
  function postSheetVehicle(payload) {
    const config = sheetSaveSettings();
    if (!/^https:\/\/script\.google\.com\/macros\/s\//i.test(config.webAppUrl || ''))
      return Promise.reject(new Error('Add the Google Sheets Web App URL in Settings first'));
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method:'POST', url:config.webAppUrl, timeout:30000, redirects:'follow',
      headers:{ 'Content-Type':'text/plain;charset=UTF-8' },
      data:JSON.stringify({ ...payload, secret:config.secret || '' }),
      onload:(response) => {
        let value = {}; try { value = JSON.parse(response.responseText || '{}'); } catch (_) {}
        if ((response.status === 0 || (response.status >= 200 && response.status < 400)) && value.ok) resolve(value);
        else {
          const raw = String(response.responseText || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          reject(new Error(value.error || raw.slice(0, 180) || `Sheet save error ${response.status}`));
        }
      },
      onerror:() => reject(new Error('Could not reach Google Sheets saver')),
      ontimeout:() => reject(new Error('Google Sheets saver timed out')),
    }));
  }
  async function saveCurrentVehicle() {
    const vehicle = readVehicle();
    if (!vehicle.vin || !vehicle.mileage) { render('Open a vehicle page with VIN and mileage first.'); return; }
    let sheet = sheetSaveSettings();
    if (!sheet.secret) {
      const secret = prompt('Enter the Sheets saver secret. It will be stored only in this browser:');
      if (!String(secret || '').trim()) { render('Saving cancelled — enter the Sheets saver secret to continue.'); return; }
      GM_setValue(SHEET_SAVE_SETTINGS_KEY, { secret:String(secret).trim() });
      sheet = sheetSaveSettings();
    }
    const button = document.getElementById('ove-save-vehicle');
    if (button) { button.disabled = true; button.textContent = '…'; }
    const kbb = GM_getValue(`oveKbbPrivateResult:${vehicle.vin}`, null) || {};
    const carfax = GM_getValue(`oveCarfaxResult:${vehicle.vin}`, null) || {};
    const deal = readDealSettings(vehicle.vin);
    const payload = {
        vin:vehicle.vin, title:vehicle.title, mileage:vehicle.mileage, color:vehicle.color,
        pageUrl:location.href, laneRun:readLaneRun(), savedBy:GM_getValue('vin_marker_active_profile_v1', '') || '',
        kbbFair:Number(kbb.values?.fair?.value || 0), kbbGood:Number(kbb.values?.good?.value || 0),
        carfaxRetail:Number(carfax.retailValue || 0), carfaxUrl:carfax.reportUrl || '',
        purchasePrice:Number(deal.purchasePrice || 0), extra:Number(deal.delivery || 0) + Number(deal.extra || 0),
    };
    try {
      let response;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await postSheetVehicle(payload);
          break;
        } catch (error) {
          if (attempt !== 0 || !/unauthorized/i.test(String(error?.message || error))) throw error;
          const secret = prompt('The saved secret was rejected. Enter the correct Sheets saver secret:');
          if (!String(secret || '').trim()) throw new Error('Unauthorized');
          GM_setValue(SHEET_SAVE_SETTINGS_KEY, { secret:String(secret).trim() });
        }
      }
      if (!response) throw new Error('Google Sheets saver did not return a result');
      GM_setValue(`auctionAssistantSheetSaved:${vehicle.vin}`, { row:response.row, savedAt:Date.now() });
      publishSharedSheetRow(vehicle.vin, response.row);
      render(response.duplicate ? `Already saved in Manheim v2 · row ${response.row}` : `Saved to Manheim v2 · row ${response.row}`);
    } catch (error) {
      const message = `Could not save to Manheim v2: ${error.message || error}`;
      render(message);
      alert(message);
    }
  }
  function makePanel() {
    if (document.getElementById('ove-kbb-panel')) return;
    const panel = document.createElement('aside');
    panel.id = 'ove-kbb-panel';
    panel.innerHTML = `<style>
      #ove-kbb-panel{position:fixed;z-index:2147483647;top:24px;right:16px;width:382px;max-height:calc(100vh - 48px);
        color:#30343b;background:#f8fafc;border:1px solid #d7dce3;border-radius:16px;box-shadow:0 18px 45px #0005;
        font:14px/1.35 system-ui,-apple-system,sans-serif;overflow:auto;transition:transform .22s ease,opacity .22s ease}
      #ove-kbb-panel.is-hidden{transform:translateX(calc(100% + 36px));opacity:0;pointer-events:none}
      #ove-kbb-panel *{box-sizing:border-box}#ove-kbb-panel header{display:flex;justify-content:space-between;
        align-items:center;padding:15px 18px;background:#fff;border-bottom:1px solid #e5e7eb;position:sticky;top:0;z-index:3}
      #ove-kbb-panel h2{font-size:18px;margin:0}#ove-kbb-panel .body{padding:20px 16px}
      #ove-kbb-panel .head-actions{display:flex;align-items:center;gap:5px}
      #ove-kbb-panel #vin-marker-account-row{margin:0!important;padding:0!important;border:0!important;display:block!important}
      #ove-kbb-panel #vin-marker-account-row>span{display:none!important}
      #ove-kbb-panel #vin-marker-account-row select{max-width:92px!important;height:31px!important;padding:3px 6px!important;
        font-size:12px!important;color:#465365!important}
      #ove-kbb-panel .vehicle{font-size:16px;font-weight:750;margin-bottom:4px}#ove-kbb-panel .muted{color:#8da0bc}
      #ove-kbb-panel .manual{padding:14px;border:1px solid #d8dee8;border-radius:12px;background:#fff}
      #ove-kbb-panel .manual-title{font-size:15px;font-weight:800;margin-bottom:4px}.manual-help{font-size:12px;color:#8da0bc;margin-bottom:11px}
      #ove-kbb-panel .manual input{width:100%;height:42px;margin-bottom:8px;padding:0 11px;border:1px solid #ccd4df;
        border-radius:8px;background:#fff;color:#30343b;font:650 14px system-ui;text-transform:uppercase}
      #ove-kbb-panel .manual .manual-mileage{text-transform:none}#ove-manual-run{width:100%;padding:11px;background:#2864eb;color:#fff}
      #ove-kbb-panel .card{margin-top:12px;padding:13px;border:1px solid #d8dee8;border-radius:12px;background:#fff}
      #ove-kbb-panel .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:9px}
      #ove-kbb-panel .cell{border:1px solid #e1e5eb;border-radius:9px;padding:9px;text-align:center;background:#fff}
      #ove-kbb-panel .label{font-size:11px;color:#68707c;text-transform:uppercase;letter-spacing:.05em}
      #ove-kbb-panel .value{font-size:16px;font-weight:750;margin-top:2px}
      #ove-kbb-panel .carfax{padding:0;overflow:hidden}
      #ove-kbb-panel .carfax-head{display:flex;align-items:center;justify-content:space-between;padding:12px 13px;
        border-bottom:1px solid #e5e9ef;background:linear-gradient(180deg,#fff,#f7f9fc)}
      #ove-kbb-panel .carfax-logo{display:flex;gap:2px;align-items:center}
      #ove-kbb-panel .carfax-logo b{display:grid;place-items:center;width:19px;height:19px;background:#20242a;color:#fff;
        border-radius:2px;font-size:12px;line-height:1;font-weight:850;box-shadow:inset 0 0 0 1px #ffffff40}
      #ove-kbb-panel .carfax-head a{color:#1765c1;text-decoration:none;font-weight:750;font-size:13px}
      #ove-kbb-panel .carfax-metrics{display:grid;grid-template-columns:1.2fr 1fr .75fr;gap:0;padding:12px 6px}
      #ove-kbb-panel .carfax-metric{padding:4px 8px;text-align:center;border-right:1px solid #e5e9ef;min-width:0}
      #ove-kbb-panel .carfax-metric:last-child{border-right:0}
      #ove-kbb-panel .carfax-icon{height:25px;margin-top:7px;display:flex;align-items:center;justify-content:center}
      #ove-kbb-panel .carfax-icon img{display:block;max-width:38px;max-height:25px;object-fit:contain}
      #ove-kbb-panel .carfax-icon svg{display:block;width:25px;height:25px}#ove-kbb-panel .carfax-metric .value{font-size:15px}
      #ove-kbb-panel .carfax-retail .value{color:#187339;font-size:18px}
      #ove-kbb-panel .carfax-status{padding:0 13px 11px;text-align:center;font-size:12px;color:#8da0bc}
      #ove-kbb-panel .deal-card{padding:0;overflow:hidden}
      #ove-kbb-panel .deal-card summary{display:flex;align-items:center;justify-content:space-between;padding:12px 13px;
        cursor:pointer;list-style:none;font-weight:800;background:linear-gradient(180deg,#fff,#f7f9fc)}
      #ove-kbb-panel .deal-card summary::-webkit-details-marker{display:none}
      #ove-kbb-panel .deal-card summary span:last-child{color:#2864eb;font-size:12px}
      #ove-kbb-panel .deal-body{padding:0 13px 13px;border-top:1px solid #e5e9ef}
      #ove-kbb-panel .deal-note{font-size:11px;color:#8da0bc;margin:10px 0 8px}
      #ove-kbb-panel .deal-three{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
      #ove-kbb-panel .deal-stat{padding:8px 4px;border:1px solid #e1e5eb;border-radius:8px;text-align:center}
      #ove-kbb-panel .deal-stat .value{font-size:14px}
      #ove-kbb-panel .deal-inputs{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}
      #ove-kbb-panel .deal-field label{display:block;margin:0 0 4px;font-size:10px;color:#68707c;text-transform:uppercase;letter-spacing:.04em}
      #ove-kbb-panel .deal-field .input-wrap{display:flex;align-items:center;height:37px;border:1px solid #ccd4df;border-radius:8px;background:#fff;overflow:hidden}
      #ove-kbb-panel .deal-field .input-wrap span{padding-left:9px;color:#7a8492;font-weight:700}
      #ove-kbb-panel .deal-field input{width:100%;height:35px;padding:0 8px;border:0;outline:0;background:transparent;color:#30343b;font:750 14px system-ui}
      #ove-kbb-panel .deal-recommended{display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding:10px 12px;
        border-radius:9px;background:#eaf1ff;color:#174d9b}
      #ove-kbb-panel .deal-recommended .value{font-size:20px;color:#174d9b}
      #ove-kbb-panel .deal-profit{margin-top:9px}.deal-profit .deal-stat .value{color:#187339}
      #ove-kbb-panel .deal-profit .deal-stat.negative .value{color:#bd2c2c}
      #ove-kbb-panel .miles .value{font-size:18px}#ove-kbb-panel button{border:0;border-radius:9px;cursor:pointer;font-weight:750}
      #ove-kbb-run{width:100%;padding:11px;margin-top:11px;background:#2864eb;color:#fff;font-size:15px}
      #ove-kbb-settings{background:transparent;color:#556070;padding:3px 6px}
      #ove-save-vehicle{background:transparent;color:#d7264e;padding:3px 6px;font-size:21px;line-height:1}
      #ove-save-vehicle.is-saved{color:#d7264e}
      #ove-kbb-panel .vehicle-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
      #ove-kbb-panel .vehicle-head .vehicle{min-width:0;margin:0}
      #ove-kbb-panel .vehicle-head #ove-save-vehicle{flex:0 0 auto;font-size:24px;padding:2px 4px}
      #ove-kbb-close{background:#eef2f7;color:#465365;padding:4px 9px;font-size:18px;line-height:1}
      #ove-kbb-status{margin-top:9px;font-size:12px}.progress{height:7px;background:#e4e9f1;border-radius:99px;
        overflow:hidden;margin-top:8px}.progress i{display:block;height:100%;background:#2864eb;transition:width .4s ease}
      #ove-update-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:10px;
        padding-top:9px;border-top:1px solid #e3e8ef;color:#8da0bc;font-size:11px}
      #ove-update-now{padding:6px 9px;background:#2864eb;color:#fff;font-size:11px;border-radius:7px}
      #ove-vin-marker-card{margin:14px 16px 0;padding:13px;border:1px solid #d8dee8;border-radius:12px;background:#fff}
      #ove-vin-marker-card .marker-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}
      #ove-vin-marker-card .section-title{font-size:11px;color:#68707c;text-transform:uppercase;letter-spacing:.05em;margin:0}
      #ove-vin-marker-card .marker-card-head #vin-marker-account-row select{max-width:88px!important;height:28px!important;
        padding:2px 6px!important;border-radius:7px!important;font-size:11px!important}
      #ove-vin-marker-slot>#ove-vin-marker-content{display:grid!important;grid-template-columns:1.15fr .85fr .55fr!important;
        align-items:stretch!important;gap:7px!important;padding:0!important}
      #ove-vin-marker-slot>#ove-vin-marker-content>div:first-child{grid-column:1/-1!important;min-width:0!important;padding:8px 10px!important}
      #ove-vin-marker-slot button{width:auto!important;min-width:0!important;font-size:11px!important;padding:10px 5px!important}
      #ove-vin-marker-slot select{width:100%!important;min-width:0!important;max-width:none!important;padding:8px 4px!important;font-size:10px!important}
      #ove-vin-marker-slot .marker-stats-button{position:absolute!important;width:28px!important;height:25px!important;
        padding:0!important;font-size:14px!important}
      #ove-assistant-toggle{position:fixed;right:0;top:36%;z-index:2147483647;display:flex;flex-direction:column;
        align-items:center;gap:7px;padding:14px 9px 12px;border:0;border-radius:13px 0 0 13px;background:#0757a6;color:#fff;
        box-shadow:0 6px 20px #0004;cursor:pointer;font:800 12px system-ui;letter-spacing:.04em;transition:transform .2s,opacity .2s}
      #ove-assistant-toggle .toggle-icon{font-size:20px;line-height:1}#ove-assistant-toggle .toggle-text{writing-mode:vertical-rl;
        text-orientation:mixed}#ove-assistant-toggle.panel-open{transform:translateX(100%);opacity:0;pointer-events:none}
      .vin-marker-filter-hidden{display:none!important}
      .pulse{animation:kbbPulse 1.25s ease-in-out infinite}@keyframes kbbPulse{50%{opacity:.5}}
    </style><header><h2>${AUCTION_SITE} Auction Assistant</h2><div class="head-actions"><button id="ove-kbb-settings" title="Settings">⚙</button>
      <button id="ove-kbb-close" title="Hide panel">×</button></div></header>
    <section id="ove-assistant-content">${IS_SUPPORTED_AUCTION ? '<div id="ove-vin-marker-card"><div class="marker-card-head"><div class="section-title">VIN Marker</div><div id="ove-vin-marker-account-slot"></div></div><div id="ove-vin-marker-slot"></div></div>' : ''}
      <div class="body"><div id="ove-kbb-content">Reading ${AUCTION_SITE}…</div>
        <div id="ove-update-footer"><span>v${SCRIPT_VERSION}</span></div></div></section>`;
    document.documentElement.appendChild(panel);
    const toggle = document.createElement('button');
    toggle.id = 'ove-assistant-toggle';
    toggle.title = `Open ${AUCTION_SITE} Auction Assistant`;
    toggle.innerHTML = '<span class="toggle-icon">🚘</span><span class="toggle-text">ASSISTANT</span>';
    document.documentElement.appendChild(toggle);
    const getUi = () => ({ open: true, ...(GM_getValue(ASSISTANT_UI_KEY, {}) || {}) });
    const saveUi = (next) => GM_setValue(ASSISTANT_UI_KEY, { ...getUi(), ...next });
    const setOpen = (open) => {
      panel.classList.toggle('is-hidden', !open);
      toggle.classList.toggle('panel-open', open);
      saveUi({ open });
    };
    panel.querySelector('#ove-kbb-close').onclick = () => setOpen(false);
    toggle.onclick = () => setOpen(true);
    setOpen(getUi().open);
    const attachMarker = () => {
      const source = document.getElementById('ove-vin-marker-source');
      const markerContent = document.getElementById('ove-vin-marker-content');
      const slot = document.getElementById('ove-vin-marker-slot');
      if (!source || !markerContent || !slot || slot.contains(markerContent)) return;
      slot.appendChild(markerContent);
      const account = document.getElementById('vin-marker-account-row');
      const accountSlot = panel.querySelector('#ove-vin-marker-account-slot');
      if (account && accountSlot) accountSlot.appendChild(account);
      source.style.display = 'none';
    };
    attachMarker(); setTimeout(attachMarker, 300); setTimeout(attachMarker, 1200);
    panel.querySelector('#ove-kbb-settings').onclick = () => {
      const current = settings(); const zip = prompt('ZIP code:', current.zip);
      if (/^\d{5}$/.test(zip || '')) GM_setValue(SETTINGS_KEY, { zip });
      const sheet = sheetSaveSettings();
      const secret = prompt('Sheets saver secret (stored only in this browser):', sheet.secret || '');
      if (secret !== null) GM_setValue(SHEET_SAVE_SETTINGS_KEY, { secret:String(secret || '').trim() });
      render();
    };
    refreshUpdateFooter();
    setTimeout(() => checkForUpdates(false), 700);
  }
  function compareVersions(left, right) {
    const a = String(left || '').split('.').map((part) => Number(part) || 0);
    const b = String(right || '').split('.').map((part) => Number(part) || 0);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      if ((a[index] || 0) > (b[index] || 0)) return 1;
      if ((a[index] || 0) < (b[index] || 0)) return -1;
    }
    return 0;
  }
  function refreshUpdateFooter() {
    const footer = document.getElementById('ove-update-footer');
    if (!footer) return;
    footer.innerHTML = `<span>v${SCRIPT_VERSION}</span>${availableUpdate ?
      `<button id="ove-update-now" title="Install latest version">Update to v${availableUpdate.version}</button>` : ''}`;
    const button = document.getElementById('ove-update-now');
    if (button) button.onclick = () => window.open(availableUpdate.url || UPDATE_SCRIPT_URL, '_blank', 'noopener');
  }
  function checkForUpdates(force = false) {
    if (updateCheckStarted && !force) return;
    const cached = GM_getValue(UPDATE_CHECK_STORAGE, null);
    const fresh = cached?.checkedAt && Date.now() - Number(cached.checkedAt) < 2 * 60 * 60 * 1000;
    if (!force && fresh) {
      availableUpdate = compareVersions(cached.version, SCRIPT_VERSION) > 0 ? cached : null;
      refreshUpdateFooter();
      return;
    }
    updateCheckStarted = true;
    GM_xmlhttpRequest({
      method: 'GET', url: `${UPDATE_MANIFEST_URL}?t=${Date.now()}`, timeout: 12000,
      headers: { 'Cache-Control': 'no-cache' },
      onload: (response) => {
        try {
          const manifest = JSON.parse(response.responseText || '{}');
          if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ''))) throw new Error('Invalid update manifest');
          const checked = {
            version: String(manifest.version),
            url: String(manifest.scriptUrl || UPDATE_SCRIPT_URL),
            checkedAt: Date.now()
          };
          GM_setValue(UPDATE_CHECK_STORAGE, checked);
          availableUpdate = compareVersions(checked.version, SCRIPT_VERSION) > 0 ? checked : null;
          refreshUpdateFooter();
        } catch (_) {}
      },
      onerror: () => {}, ontimeout: () => {}
    });
  }
  function safeCarfaxImage(url) {
    return /^(?:https?:|data:image\/)/i.test(url || '')
      ? `<img src="${String(url).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" alt="">`
      : '';
  }
  function accidentIcon(carfax) {
    if (carfax?.accidentType === 'clean' || carfax?.accidents === 0) return '<svg viewBox="0 0 32 32" aria-label="Clean history"><circle cx="16" cy="16" r="14" fill="#159447"/><path d="m9 16 4.2 4.3L23 10.8" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return '<svg viewBox="0 0 32 32" aria-label="Accident or damage"><path d="M16 3 30 28H2Z" fill="#f5b400"/><path d="M16 11v8M16 23v1" stroke="#272727" stroke-width="2.8" stroke-linecap="round"/></svg>';
  }
  function ownerIcon(carfax) {
    const ownerTotal = Number(carfax?.owners) || 1;
    if (ownerTotal === 1) {
      return '<svg viewBox="0 0 32 32" aria-label="CARFAX 1-Owner Vehicle"><path d="M16 2.3 20 4l4.3-.2 2.1 3.8 3.6 2.4-.6 4.3 1.6 4-3.1 3-.7 4.3-4.2 1.1-3.2 2.9-3.8-2-3.8 2-3.2-2.9-4.2-1.1-.7-4.3-3.1-3 1.6-4-.6-4.3 3.6-2.4 2.1-3.8 4.3.2Z" fill="#0868b9"/><text x="16" y="21.2" fill="#fff" font-size="15" font-weight="900" text-anchor="middle" font-family="Arial,sans-serif">1</text></svg>';
    }
    const count = Math.max(2, Math.min(4, ownerTotal));
    const positions = count === 1 ? [16] : count === 2 ? [10,22] : count === 3 ? [7,16,25] : [5,12.5,19.5,27];
    const people = positions.map(x => `<circle cx="${x}" cy="10" r="3.4"/><path d="M${x - 5} 24c.4-6 2.1-9 5-9s4.6 3 5 9Z"/>`).join('');
    return `<svg viewBox="0 0 32 32" aria-label="${carfax?.owners || ''} owners"><g fill="#2477a9">${people}</g></svg>`;
  }
  function readDealSettings(vin) {
    const global = GM_getValue(DEAL_SETTINGS_KEY, {}) || {};
    const vehicle = GM_getValue(`${DEAL_SETTINGS_KEY}:${vin}`, {}) || {};
    return {
      feePercent: Number(global.feePercent ?? 6),
      targetProfit: Number(global.targetProfit ?? 2000),
      delivery: Number(vehicle.delivery ?? 0),
      extra: Number(vehicle.extra ?? 0),
      purchasePrice: Number(vehicle.purchasePrice ?? 0),
    };
  }
  function calculateDeal(values, carfax, config) {
    const sources = [values?.fair?.value, values?.good?.value, carfax?.retailValue].map(Number);
    if (sources.some((value) => !Number.isFinite(value) || value <= 0)) return null;
    const saleMax = sources.reduce((sum, value) => sum + value, 0) / sources.length;
    const saleMin = saleMax * 0.9;
    const saleAverage = (saleMax + saleMin) / 2;
    const priceWithProfitGap = saleMin - config.targetProfit;
    const fee = priceWithProfitGap * (config.feePercent / 100);
    const recommendedBuy = priceWithProfitGap - fee - config.delivery - config.extra;
    const purchase = config.purchasePrice;
    const profitMax = purchase > 0 ? saleMax - fee - config.delivery - config.extra - purchase : null;
    const profitMin = purchase > 0 ? saleMin - fee - config.delivery - config.extra - purchase : null;
    return {
      saleMax, saleAverage, saleMin, fee, recommendedBuy,
      profitMax, profitAverage: purchase > 0 ? (profitMax + profitMin) / 2 : null, profitMin,
    };
  }
  function dealStat(label, value, className = '') {
    const negative = Number.isFinite(value) && value < 0 ? ' negative' : '';
    return `<div class="deal-stat ${className}${negative}"><div class="label">${label}</div><div class="value">${money(value)}</div></div>`;
  }
  function dealMarkup(vin, values, carfax) {
    const config = readDealSettings(vin);
    const deal = calculateDeal(values, carfax, config);
    return `<details class="card deal-card" open><summary><span>Deal Calculator</span><span>Profit & purchase ▾</span></summary>
      <div class="deal-body">
        <div class="deal-note">Sale estimate from KBB Fair, KBB Good and CARFAX Retail</div>
        <div class="deal-three">${dealStat('Max sale', deal?.saleMax)}${dealStat('Average', deal?.saleAverage)}${dealStat('Min sale', deal?.saleMin)}</div>
        <div class="deal-inputs">
          <div class="deal-field"><label>Minimum profit</label><div class="input-wrap"><span>$</span><input data-deal="targetProfit" inputmode="numeric" value="${config.targetProfit || ''}"></div></div>
          <div class="deal-field"><label>Auction fee</label><div class="input-wrap"><input data-deal="feePercent" inputmode="decimal" value="${config.feePercent}"><span style="padding:0 9px 0 0">%</span></div></div>
          <div class="deal-field"><label>Delivery</label><div class="input-wrap"><span>$</span><input data-deal="delivery" inputmode="numeric" value="${config.delivery || ''}" placeholder="0"></div></div>
          <div class="deal-field"><label>Additional costs</label><div class="input-wrap"><span>$</span><input data-deal="extra" inputmode="numeric" value="${config.extra || ''}" placeholder="0"></div></div>
        </div>
        <div class="deal-recommended"><div><div class="label">Recommended max buy</div><div style="font-size:10px;opacity:.8">Includes profit, fee and costs</div></div><div class="value">${money(deal?.recommendedBuy)}</div></div>
        <div class="deal-field" style="margin-top:10px"><label>Your purchase price</label><div class="input-wrap"><span>$</span><input data-deal="purchasePrice" inputmode="numeric" value="${config.purchasePrice || ''}" placeholder="Enter price"></div></div>
        <div class="deal-three deal-profit">${dealStat('Max profit', deal?.profitMax)}${dealStat('Average', deal?.profitAverage)}${dealStat('Min profit', deal?.profitMin)}</div>
        ${deal ? `<div class="deal-note">Calculated fee: ${money(deal.fee)}</div>` : '<div class="deal-note">Waiting for KBB Fair, KBB Good and CARFAX Retail values.</div>'}
      </div></details>`;
  }
  function bindDealInputs(vin) {
    document.querySelectorAll('#ove-kbb-content [data-deal]').forEach((input) => {
      input.onchange = () => {
        const field = input.dataset.deal;
        const value = Number(String(input.value || '').replace(/[^\d.]/g, '')) || 0;
        if (field === 'feePercent' || field === 'targetProfit') {
          const global = GM_getValue(DEAL_SETTINGS_KEY, {}) || {};
          GM_setValue(DEAL_SETTINGS_KEY, { ...global, [field]: value });
        } else {
          const key = `${DEAL_SETTINGS_KEY}:${vin}`;
          const vehicle = GM_getValue(key, {}) || {};
          GM_setValue(key, { ...vehicle, [field]: value });
        }
        render();
      };
    });
  }
  function render(message = '') {
    makePanel();
    const vehicle = readVehicle(); const config = settings();
    const sheetSaved = vehicle.vin ? GM_getValue(`auctionAssistantSheetSaved:${vehicle.vin}`, null) : null;
    const result = vehicle.vin ? GM_getValue(`oveKbbPrivateResult:${vehicle.vin}`, null) : null;
    const job = vehicle.vin ? GM_getValue(kbbJobKey(vehicle.vin), null) : null;
    const active = job?.vin === vehicle.vin && !job.completedAt;
    const values = result?.values || {};
    const carfax = GM_getValue(`oveCarfaxResult:${vehicle.vin}`, null);
    const carfaxJob = GM_getValue(CARFAX_JOB_KEY, null);
    const carfaxActive = carfaxJob?.vin === vehicle.vin && !carfaxJob.completedAt;
    const carfaxClean = carfax && (carfax.accidentType === 'clean' || carfax.accidents === 0);
    const carfaxAccidentLabel = carfaxClean ? 'No Accidents or Damage' : 'Accident';
    const progress = active ? Number(job.progress || 5) : (result ? 100 : 0);
    const conditions = [['fair','Fair'],['good','Good'],['very-good','Very Good'],['excellent','Excellent']];
    const target = document.getElementById('ove-kbb-content');
    if (!vehicle.vin || !vehicle.mileage) {
      target.innerHTML = `<div class="manual"><div class="manual-title">Manual vehicle lookup</div>
        <div class="manual-help">Enter a VIN and mileage when the auction page cannot provide them.</div>
        <input id="ove-manual-vin" maxlength="17" autocomplete="off" placeholder="17-digit VIN" value="${vehicle.vin || ''}">
        <input id="ove-manual-mileage" class="manual-mileage" inputmode="numeric" autocomplete="off" placeholder="Mileage" value="${vehicle.mileage || ''}">
        <button id="ove-manual-run">Check VIN</button>
        ${message ? `<div class="muted" style="margin-top:8px">${message}</div>` : ''}</div>`;
      document.getElementById('ove-manual-run').onclick = () => {
        const vin = document.getElementById('ove-manual-vin').value.trim().toUpperCase();
        const mileage = Number(document.getElementById('ove-manual-mileage').value.replace(/[^\d]/g, ''));
        if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) { render('Enter a valid 17-character VIN.'); return; }
        if (!mileage) { render('Enter the vehicle mileage.'); return; }
        GM_setValue(MANUAL_VEHICLE_KEY, { vin, mileage, pageUrl: location.href, savedAt: Date.now() });
        render(); run();
      };
      return;
    }
    target.innerHTML = `<div class="vehicle-head"><div class="vehicle">${vehicle.title}</div><button id="ove-save-vehicle" title="Save vehicle to Manheim v2">${sheetSaved ? '♥' : '♡'}</button></div><div class="muted">${vehicle.vin}</div>
      <div class="grid miles">
        <div class="cell"><div class="label">Avg. Mileage</div><div class="value">${miles(result?.avgMileage)}</div></div>
        <div class="cell"><div class="label">ODO</div><div class="value">${miles(vehicle.mileage || result?.odo)}</div></div>
      </div>
      <div class="card"><div class="label">Private Party Values</div><div class="grid">
        ${conditions.map(([key,label]) => `<div class="cell"><div class="label">${label}</div>
          <div class="value ${active && !values[key] ? 'pulse' : ''}">${money(values[key]?.value)}</div></div>`).join('')}
      </div><div class="muted" style="margin-top:9px">ZIP ${result?.zip || config.zip}${result?.date ? ` · ${result.date}` : ''}</div></div>
      <div class="card carfax">
        <div class="carfax-head"><div class="carfax-logo" aria-label="CARFAX">${[...'CARFAX'].map(letter => `<b>${letter}</b>`).join('')}</div>
          ${carfax?.reportUrl ? `<a href="${carfax.reportUrl}" target="_blank" rel="noopener">View Report ↗</a>` : '<span class="muted">Vehicle History</span>'}</div>
        <div class="carfax-metrics">
          <div class="carfax-metric carfax-retail"><div class="label">Retail Value</div><div class="value">${money(carfax?.retailValue)}</div></div>
          <div class="carfax-metric"><div class="label">${carfax ? carfaxAccidentLabel : 'Accidents / Damage'}</div>${carfax ? `<div class="carfax-icon">${accidentIcon(carfax)}</div>` : '<div class="value">—</div>'}</div>
          <div class="carfax-metric"><div class="label">${carfax?.owners != null ? `${carfax.owners} Owner${carfax.owners === 1 ? '' : 's'}` : 'Owners'}</div>${carfax ? `<div class="carfax-icon">${ownerIcon(carfax)}</div>` : '<div class="value">—</div>'}</div>
        </div>
        ${!carfax ? `<div class="carfax-status">${carfaxJob?.vin === vehicle.vin ? (carfaxJob.stage || 'Report pending') : 'Report pending'}</div>` : ''}
      </div>
      ${dealMarkup(vehicle.vin, values, carfax)}
      <button id="ove-kbb-run">${result || carfax ? 'Refresh KBB + CARFAX' : 'Get KBB + CARFAX'}</button>
      ${active ? `<div class="progress"><i style="width:${Math.min(100, progress)}%"></i></div>` : ''}
      <div id="ove-kbb-status" class="muted">${message || (active ? `${job.stage || 'Working'}${job.eta ? ` · ~${job.eta}s` : ''}` :
        `Color: ${vehicle.color} · ZIP: ${config.zip}`)}</div>`;
    const saveButton = document.getElementById('ove-save-vehicle');
    if (saveButton) {
      saveButton.classList.toggle('is-saved', Boolean(sheetSaved));
      saveButton.title = sheetSaved ? `Saved in Manheim v2 · row ${sheetSaved.row || ''}` : 'Save vehicle to Manheim v2';
      saveButton.onclick = () => saveCurrentVehicle();
    }
    document.getElementById('ove-kbb-run').onclick = (event) => { event.preventDefault(); run(); };
    bindDealInputs(vehicle.vin);
  }
  function carfaxRequest(method, url, data) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method, url, timeout: 30000, anonymous: false, withCredentials: true,
      headers: data ? { 'Content-Type': 'application/json' } : undefined,
      data: data ? JSON.stringify(data) : undefined,
      onload: resolve, onerror: () => reject(new Error('CARFAX request failed')),
      ontimeout: () => reject(new Error('CARFAX request timed out')),
    }));
  }
  async function startCarfax(vehicle) {
    GM_setValue(`oveCarfaxResult:${vehicle.vin}`, null);
    GM_setValue(CARFAX_JOB_KEY, { ...vehicle, vin: vehicle.vin, startedAt: Date.now(), stage: 'Opening CARFAX' });
    try {
      const response = await carfaxRequest('POST', 'https://carfax-app.vercel.app/api/pro/requests', {
        vin: vehicle.vin, plate: null, state: null,
      });
      let payload = {};
      try { payload = JSON.parse(response.responseText || '{}'); } catch (_) {}
      if (response.status === 401 || response.status === 403) throw new Error('Sign in to partner CARFAX in Chrome');
      if (response.status < 200 || response.status >= 300) throw new Error(payload.error || `CARFAX error ${response.status}`);
      const requestId = payload.request?.id;
      if (!requestId) throw new Error('CARFAX did not return a report ID');
      const reportUrl = `https://carfax-app.vercel.app/pro/report/${requestId}`;
      let pending = GM_getValue(CARFAX_JOB_KEY, {});
      GM_setValue(CARFAX_JOB_KEY, { ...pending, reportUrl, requestId, stage: 'Generating CARFAX report' });
      if (payload.htmlContent && saveCarfaxText(carfaxHtmlToText(payload.htmlContent), reportUrl, payload.htmlContent)) return;

      for (let attempt = 0; attempt < 80; attempt++) {
        await sleep(1250);
        const current = GM_getValue(CARFAX_JOB_KEY, null);
        if (!current || current.completedAt) return;
        // The completed report page contains a short-lived signed URL to the CARFAX HTML file.
        const page = await carfaxRequest('GET', reportUrl);
        if (page.status === 200) {
          const normalized = (page.responseText || '').replace(/\\\//g, '/').replace(/\\u0026/g, '&');
          const fileMatch = normalized.match(/(?:https:\/\/carfax-app\.vercel\.app)?\/api\/files\/[^"'<>\s]+/i);
          if (fileMatch) {
            const fileUrl = fileMatch[0].startsWith('http') ? fileMatch[0] : `https://carfax-app.vercel.app${fileMatch[0]}`;
            const file = await carfaxRequest('GET', fileUrl);
            if (file.status === 200) {
              const decoded = carfaxHtmlToText(file.responseText);
              if (saveCarfaxText(decoded, reportUrl, file.responseText)) return;
            }
          }
        }
        pending = GM_getValue(CARFAX_JOB_KEY, {});
        GM_setValue(CARFAX_JOB_KEY, { ...pending, stage: `Generating CARFAX report · ${attempt + 1}s` });
      }
      throw new Error('CARFAX report timed out');
    } catch (error) {
      const pending = GM_getValue(CARFAX_JOB_KEY, {}) || {};
      GM_setValue(CARFAX_JOB_KEY, { ...pending, stage: error.message, error: error.message, completedAt: Date.now() });
    }
  }
  function savePartial(vehicle, config, state) {
    if (!state.result) return;
    const old = GM_getValue(`oveKbbPrivateResult:${vehicle.vin}`, {}) || {};
    // Compatibility with bridge 2.4.0, which returned the first Fair value flat.
    const incomingValues = state.result.values ||
      (state.result.value ? { fair: { low: state.result.low, high: state.result.high, value: state.result.value } } : {});
    const saved = {
      ...old, vin: vehicle.vin, zip: config.zip, date: new Date().toLocaleDateString('en-US'),
      avgMileage: state.result.avgMileage ?? old.avgMileage,
      odo: state.result.odo ?? vehicle.mileage,
      values: { ...(old.values || {}), ...incomingValues },
    };
    GM_setValue(`oveKbbPrivateResult:${vehicle.vin}`, saved);
    publishSharedResult(vehicle.vin, vehicle);
  }
  async function runLocalKbb(vehicle, config, reason = '') {
    const startedAt = Date.now();
    const current = await bridge('GET');
    if (current.status === 'working' && current.vin && current.vin !== vehicle.vin)
      throw new Error(`KBB Bridge is busy with VIN ${current.vin}`);
    GM_setValue(kbbJobKey(vehicle.vin), {
      ...vehicle, stage:reason ? 'Cloud quota reached · using local KBB Bridge' : 'Using local KBB Bridge',
      progress:3, startedAt
    });
    render();
    const accepted = await bridge('POST', { ...vehicle, zip:config.zip });
    if (accepted.status === 'error') throw new Error(accepted.message || 'Local KBB Bridge error');
    const deadline = Date.now() + 12 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(1200);
      const state = await bridge('GET');
      savePartial(vehicle, config, state);
      const done = state.status === 'done';
      GM_setValue(kbbJobKey(vehicle.vin), {
        ...vehicle, stage:state.message || 'KBB in progress on this Mac',
        progress:state.progress || 3, eta:state.eta, startedAt,
        completedAt:done ? Date.now() : null
      });
      render();
      if (done) return;
      if (state.status === 'error') throw new Error(state.message || 'Local KBB Bridge failed');
    }
    throw new Error('Timed out waiting for local KBB Bridge');
  }
  async function run() {
    if (Date.now() - lastRun < 1500) return; lastRun = Date.now();
    const vehicle = readVehicle(); const config = settings();
    if (!vehicle.vin || !vehicle.mileage) { render('Could not read VIN or mileage.'); return; }
    GM_setValue(`oveKbbPrivateResult:${vehicle.vin}`, null);
    GM_setValue(kbbJobKey(vehicle.vin), { ...vehicle, stage:'Adding to shared KBB queue', progress:2, startedAt:Date.now() });
    render();
    try {
      startCarfax(vehicle);
      try {
        await bridge('GET');
        await runLocalKbb(vehicle, config);
        return;
      } catch (localError) {
        if (!/not running|did not respond|network/i.test(localError.message || '')) throw localError;
      }
      let cloudJobId;
      try {
        cloudJobId = await enqueueSharedKbb(vehicle, config.zip);
      } catch (cloudError) {
        if (cloudError.status === 429 || /quota|too many requests|resource_exhausted/i.test(cloudError.message || '')) {
          await runLocalKbb(vehicle, config, cloudError.message);
          return;
        }
        throw cloudError;
      }
      GM_setValue(kbbJobKey(vehicle.vin), { ...vehicle, cloudJobId, stage:'Waiting in KBB queue', progress:3, startedAt:Date.now() });
      const deadline = Date.now() + 12 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(5000);
        const { state:queue } = await readSharedKbbQueue();
        const state = queue.jobs?.[cloudJobId];
        if (!state) throw new Error('KBB queue lost this request');
        savePartial(vehicle, config, state);
        const done = state.status === 'done';
        const position = queue.pending.indexOf(cloudJobId);
        const stage = state.status === 'queued'
          ? (queue.active?.id && queue.active.id !== cloudJobId
              ? `KBB busy · another vehicle in process · queue position ${Math.max(1, position + 1)}`
              : (position >= 0 ? `In queue · position ${position + 1}` : 'Waiting in KBB queue'))
          : (state.message || 'KBB in progress on Vlad’s Mac');
        GM_setValue(kbbJobKey(vehicle.vin), { ...vehicle, cloudJobId, stage, progress:state.progress || 3,
          eta:state.eta, startedAt:state.startedAt || state.createdAt || Date.now(), completedAt:done ? Date.now() : null });
        render();
        if (done) return;
        if (state.status === 'error') throw new Error(state.message || 'KBB failed');
      }
      throw new Error('Timed out waiting in shared KBB queue');
    } catch (error) {
      GM_setValue(kbbJobKey(vehicle.vin), { ...vehicle, completedAt:Date.now(), error:error.message });
      render(error.message);
    }
  }
  makePanel(); render();
  GM_addValueChangeListener(CARFAX_JOB_KEY, () => {
    const current = GM_getValue(CARFAX_JOB_KEY, null);
    render();
  });
  let lastUrl = location.href;
  let lastVehicleSignature = '';
  function refreshIfVehicleChanged(force = false) {
    const vehicle = readVehicle();
    const signature = `${location.href}|${vehicle.vin}|${vehicle.mileage}|${vehicle.title}|${vehicle.color}`;
    if (!force && signature === lastVehicleSignature) return;
    lastVehicleSignature = signature;
    render();
    hydrateSharedResult(vehicle, force).then((loaded) => { if (loaded) render('Loaded shared KBB/CARFAX data'); });
  }
  refreshIfVehicleChanged(true);
  let helperMutationTimer;
  const helperObserver = new MutationObserver(() => {
    clearTimeout(helperMutationTimer);
    helperMutationTimer = setTimeout(() => refreshIfVehicleChanged(false), 450);
  });
  helperObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastVehicleSignature = '';
      refreshIfVehicleChanged(true);
    }
  }, 800);
})();
