/* Dropbox app-folder sync for the property renewals page.
 * Constraints honoured here (per owner instructions):
 * - PKCE code flow, token_access_type=online: short-lived access token only, NO refresh token.
 * - Access token lives in page memory ONLY. Never localStorage, never published code, never sent anywhere except api/content.dropboxapi.com.
 * - PKCE verifier + state live in sessionStorage for the duration of the auth bounce only and are deleted immediately on return.
 * - The OAuth callback scrubs ?code&state from the URL with history.replaceState before any other work, so they never sit in history.
 * - App is scoped to its own Dropbox app folder; the token cannot reach any other file in the user's Dropbox.
 * - Writes are pinned to the revision read; a 409 conflict means the file changed elsewhere and the caller must re-read, never blind-overwrite.
 */
var DbxSync = (function () {
    var APP_KEY = 'zcbbiafvvnsfsj9'; // public client id, not a secret
    var REDIRECT = window.location.origin + window.location.pathname; // exact registered redirect URI
    var MASTER_PATH = '/property-renewals.csv';
    var token = null; // memory only
    var accountName = null;

    function b64url(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function randomString(n) {
        var a = new Uint8Array(n);
        crypto.getRandomValues(a);
        return b64url(a);
    }
    function sha256(text) {
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (d) { return b64url(new Uint8Array(d)); });
    }

    function isConnected() { return !!token; }
    function connectedAs() { return accountName; }

    // Start auth: same-tab top-level redirect to Dropbox. Verifier+state in sessionStorage for this bounce only.
    function connect() {
        var verifier = randomString(64);
        var state = randomString(24);
        return sha256(verifier).then(function (challenge) {
            sessionStorage.setItem('dbx_pkce', JSON.stringify({ verifier: verifier, state: state, t: Date.now() }));
            var url = 'https://www.dropbox.com/oauth2/authorize?client_id=' + APP_KEY
                + '&redirect_uri=' + encodeURIComponent(REDIRECT)
                + '&response_type=code&code_challenge_method=S256&code_challenge=' + challenge
                + '&state=' + encodeURIComponent(state) + '&token_access_type=online';
            window.location.assign(url);
        });
    }

    // Call on every page load. If this load is the OAuth return, completes the exchange and scrubs the URL first.
    // Returns 'returned' | 'idle'. Resolves connected state via callback.
    function handleReturn(onConnected, onError) {
        var params = new URLSearchParams(window.location.search);
        var code = params.get('code'), state = params.get('state'), err = params.get('error');
        if (!code && !err) return 'idle';
        // Scrub the callback URL before anything else happens.
        history.replaceState(null, '', REDIRECT);
        if (err) { sessionStorage.removeItem('dbx_pkce'); onError('Dropbox sign-in was cancelled or failed (' + err + ').'); return 'returned'; }
        var stored = null;
        try { stored = JSON.parse(sessionStorage.getItem('dbx_pkce') || 'null'); } catch (e) { /* ignore */ }
        sessionStorage.removeItem('dbx_pkce'); // transient only, gone now either way
        if (!stored || stored.state !== state || Date.now() - stored.t > 15 * 60 * 1000) {
            onError('Sign-in check failed (state mismatch or expired). Please tap Connect again.');
            return 'returned';
        }
        var body = new URLSearchParams({
            grant_type: 'authorization_code', code: code, redirect_uri: REDIRECT,
            code_verifier: stored.verifier, client_id: APP_KEY
        });
        fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: body })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
                if (!res.ok) { onError('Could not complete Dropbox sign-in. Please tap Connect again.'); return; }
                token = res.j.access_token;
                return fetch('https://api.dropboxapi.com/2/users/get_current_account', {
                    method: 'POST', headers: { Authorization: 'Bearer ' + token }
                }).then(function (r) { return r.json(); }).then(function (acct) {
                    accountName = acct && acct.name ? acct.name.display_name : null;
                    onConnected(accountName);
                });
            })
            .catch(function () { onError('Network error completing Dropbox sign-in.'); });
        return 'returned';
    }

    function rpc(path, body) {
        return fetch('https://api.dropboxapi.com/2/' + path, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); });
    }

    // Returns { status: 'ok', rev, text } | { status: 'missing' } | { status: 'error', message }
    function readMaster() {
        if (!token) return Promise.resolve({ status: 'error', message: 'not connected' });
        return fetch('https://content.dropboxapi.com/2/files/download', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': JSON.stringify({ path: MASTER_PATH }) }
        }).then(function (r) {
            if (r.status === 409) return { status: 'missing' };
            if (!r.ok) return { status: 'error', message: 'download failed (' + r.status + ')' };
            var meta = {};
            try { meta = JSON.parse(r.headers.get('Dropbox-API-Result') || '{}'); } catch (e) { /* ignore */ }
            return r.text().then(function (text) { return { status: 'ok', rev: meta.rev || '', text: text }; });
        });
    }

    // rev-pinned write. rev '' or null means create-if-absent (mode add). Returns
    // { status: 'ok', rev } | { status: 'conflict' } | { status: 'error', message }
    function writeMaster(csvText, rev) {
        if (!token) return Promise.resolve({ status: 'error', message: 'not connected' });
        var mode = rev ? { '.tag': 'update', update: rev } : 'add';
        return fetch('https://content.dropboxapi.com/2/files/upload', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + token,
                'Dropbox-API-Arg': JSON.stringify({ path: MASTER_PATH, mode: mode, mute: true }),
                'Content-Type': 'application/octet-stream'
            },
            body: csvText
        }).then(function (r) {
            if (r.status === 409) return { status: 'conflict' };
            if (!r.ok) return { status: 'error', message: 'upload failed (' + r.status + ')' };
            return r.json().then(function (j) { return { status: 'ok', rev: j.rev || '' }; });
        });
    }

    return {
        connect: connect,
        handleReturn: handleReturn,
        isConnected: isConnected,
        connectedAs: connectedAs,
        readMaster: readMaster,
        writeMaster: writeMaster,
        MASTER_PATH: MASTER_PATH
    };
})();
