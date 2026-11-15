/* Your property jobs - live two-way with the clean master CSV in Tim's Dropbox app folder.
 * The page itself holds no property data; everything loads after Dropbox sign-in. */
(function () {
    var WA_LINK = 'https://wa.me/16508702892?text=I%27ve+updated+my+property+renewal+dates+in+the+app+-+please+refresh+my+reminders.+Latest+dates+are+in+property-renewals.csv+in+my+Dropbox+app+folder.'; // prefilled WhatsApp link to Instinct, injected at deploy time

    var app = document.getElementById('app');
    var S = { rows: [], rev: '', tab: 'overview', connectedAs: null, msg: '', saving: false, seq: 0 };

    // ---------- CSV ----------
    function csvParse(text) {
        var rows = [], row = [], field = '', inQ = false, i = 0;
        text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        while (i < text.length) {
            var c = text[i];
            if (inQ) {
                if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
                field += c; i++; continue;
            }
            if (c === '"') { inQ = true; i++; continue; }
            if (c === ',') { row.push(field); field = ''; i++; continue; }
            if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
            field += c; i++;
        }
        if (field !== '' || row.length) { row.push(field); rows.push(row); }
        var head = rows.shift();
        return rows.filter(function (r) { return r.length > 1; }).map(function (r) {
            var o = {};
            head.forEach(function (h, k) { o[h] = r[k] || ''; });
            o.recur_months = parseInt(o.recur_months || '0', 10) || 0;
            return o;
        });
    }
    function csvField(v) {
        v = String(v == null ? '' : v);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    function csvSerialize(rows) {
        var head = ['property_id', 'property', 'job_id', 'job_name', 'recur_months', 'due', 'done', 'note'];
        var lines = [head.join(',')];
        rows.forEach(function (r) { lines.push(head.map(function (h) { return csvField(r[h]); }).join(',')); });
        return lines.join('\n') + '\n';
    }

    // ---------- dates ----------
    function addOneYear(iso) {
        // Calendar-year rollover from the existing date. Leap day clamps to 28 Feb.
        var p = iso.split('-'), y = +p[0], m = +p[1], d = +p[2];
        var nd = new Date(Date.UTC(y + 1, m - 1, d));
        if (nd.getUTCMonth() !== m - 1) nd = new Date(Date.UTC(y + 1, m, 0));
        return nd.getUTCFullYear() + '-' + String(nd.getUTCMonth() + 1).padStart(2, '0') + '-' + String(nd.getUTCDate()).padStart(2, '0');
    }
    function todayISO() {
        var d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function fmt(iso) {
        if (!iso) return '';
        var d = new Date(iso + 'T12:00:00');
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }
    function status(j) {
        if (j.done && !j.due) return 'done';
        if (j.due) return j.due < todayISO() ? 'passed' : 'dated';
        return 'unset';
    }

    // ---------- persistence ----------
    function save() {
        S.saving = true; render();
        var csv = csvSerialize(S.rows);
        DbxSync.writeMaster(csv, S.rev).then(function (res) {
            S.saving = false;
            if (res.status === 'ok') { S.rev = res.rev; S.msg = 'Saved to your Dropbox ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); render(); }
            else if (res.status === 'conflict') {
                S.msg = 'The sheet changed somewhere else - refreshing before your change could clash…'; render();
                load(true);
            } else { S.msg = 'Could not save (' + (res.message || res.status) + '). Your change is on screen but not in the sheet - try again.'; render(); }
        });
    }
    function load(afterConflict) {
        DbxSync.readMaster().then(function (res) {
            if (res.status === 'ok') {
                S.rows = csvParse(res.text); S.rev = res.rev;
                S.msg = afterConflict ? 'Refreshed from the sheet. If your change is missing, make it again.' : 'Up to date with your Dropbox sheet.';
                render();
            } else if (res.status === 'missing') {
                S.msg = ''; renderSetupNeeded();
            } else { S.msg = 'Could not read the sheet (' + (res.message || res.status) + ').'; render(); }
        });
    }

    // ---------- actions ----------
    window.pj = {
        tab: function (t) { S.tab = t; render(); },
        done: function (i) {
            var j = S.rows[i];
            j._undo = { due: j.due, done: j.done };
            j.done = todayISO();
            if (j.job_id === 'insurance') {
                // Tim's rule (15 Nov 2026): Done on insurance rolls the recorded date forward one year.
                if (j.due) {
                    j.due = addOneYear(j.due);
                    S.msg = 'Insurance marked done today. Next date set one year on from the previous date: ' + fmt(j.due) + '.';
                } else {
                    S.msg = 'Insurance marked done today. No date was recorded, so nothing rolled forward - set the next date manually.';
                }
            } else {
                j.due = '';
                S.msg = 'Marked done today. Set the next due date from the new certificate.';
            }
            save();
        },
        undo: function (i) {
            var j = S.rows[i]; if (!j._undo) return;
            j.due = j._undo.due; j.done = j._undo.done; delete j._undo; save();
        },
        setDue: function (i, v) { S.rows[i].due = v; delete S.rows[i]._undo; save(); },
        setNote: function (i, v) { S.rows[i].note = v; save(); },
        setDone: function (i, v) { S.rows[i].done = v; delete S.rows[i]._undo; save(); },
        del: function (i) { S.rows.splice(i, 1); save(); },
        add: function (pid) {
            var el = document.getElementById('newjob-' + pid);
            var name = (el.value || '').trim(); if (!name) return;
            var prop = S.rows.find(function (r) { return r.property_id === pid; });
            S.rows.push({ property_id: pid, property: prop ? prop.property : pid, job_id: 'custom-' + Date.now(), job_name: name, recur_months: 0, due: '', done: '', note: '' });
            el.value = ''; save();
        },
        connect: function () { DbxSync.connect(); },
        refresh: function () { if (!S.saving) { S.msg = 'Reading your Dropbox sheet...'; render(); load(false); } },
        signout: function () { location.reload(); }
    };

    // ---------- render ----------
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
    function chip(j) {
        var st = status(j);
        if (st === 'done') return '<span class="chip done">Done ' + esc(fmt(j.done)) + (j._undo ? '' : '') + '</span>';
        if (st === 'passed') return '<span class="chip passed">Date passed ' + esc(fmt(j.due)) + ' - not proof anything is missing</span>';
        if (st === 'dated') return '<span class="chip due">Recorded ' + esc(fmt(j.due)) + '</span>';
        return '<span class="chip">No date set</span>';
    }
    function jobHtml(i) {
        var j = S.rows[i];
        var h = '<div class="job"><div class="nm">' + esc(j.job_name) + '</div>';
        if (j.note) h += '<div class="note">' + esc(j.note) + '</div>';
        h += '<div>' + chip(j) + '</div><div class="row">';
        if (!j.done || j.due || j._undo == null) {
            if (!j.done) h += '<button onclick="pj.done(' + i + ')">Done</button>';
        }
        if (j._undo) h += '<button onclick="pj.undo(' + i + ')">Undo</button>';
        h += '<label>due <input type="date" value="' + esc(j.due) + '" onchange="pj.setDue(' + i + ',this.value)"></label>';
        h += '<label>done <input type="date" value="' + esc(j.done) + '" onchange="pj.setDone(' + i + ',this.value)"></label>';
        if (j.job_id.indexOf('custom-') === 0) h += '<button onclick="pj.del(' + i + ')">Remove</button>';
        h += '</div><label class="note">Notes <textarea style="display:block;box-sizing:border-box;width:100%;min-height:60px;margin-top:6px" onchange="pj.setNote(' + i + ',this.value)">' + esc(j.note) + '</textarea></label></div>';
        return h;
    }
    function renderSetupNeeded() {
        app.innerHTML = '<h1>Your property jobs</h1><div class="card err">Connected to Dropbox, but the renewals sheet is not in the app folder yet. Ask Instinct on WhatsApp to finish the setup.</div>';
    }
    function render() {
        if (S.msg === '__setup__') { renderSetupNeeded(); return; }
        var dated = S.rows.filter(function (j) { return status(j) === 'dated'; }).sort(function (a, b) { return a.due < b.due ? -1 : 1; });
        var passed = S.rows.filter(function (j) { return status(j) === 'passed'; });
        var unset = S.rows.filter(function (j) { return status(j) === 'unset'; });
        var h = '<h1>Your property jobs</h1><p class="sub">Live from your Dropbox sheet' + (S.connectedAs ? ' - ' + esc(S.connectedAs) : '') + '</p>';
        h += '<p class="status">' + (S.saving ? 'Saving…' : esc(S.msg || 'Up to date with your Dropbox sheet.')) + '</p>';
        h += '<div class="tabs"><button onclick="pj.refresh()">Refresh sheet</button><button class="' + (S.tab === 'overview' ? 'on' : '') + '" onclick="pj.tab(\'overview\')">Overview</button><button class="' + (S.tab === 'properties' ? 'on' : '') + '" onclick="pj.tab(\'properties\')">Properties</button></div>';
        if (S.tab === 'overview') {
            h += '<div class="card"><strong>' + dated.length + '</strong> dated &nbsp; <strong>' + passed.length + '</strong> date passed &nbsp; <strong>' + unset.length + '</strong> need a date';
            h += '<div class="note" style="margin-top:6px">A passed date only means the date on the job has gone by - it does not prove a certificate or check is missing.</div></div>';
            h += '<div class="card"><div class="nm" style="font-weight:600;margin-bottom:6px">Coming up</div>';
            if (!dated.length) h += '<div class="note">No dated jobs yet.</div>';
            dated.slice(0, 10).forEach(function (j) { h += '<div class="job"><div class="nm">' + esc(j.job_name) + '</div><div class="note">' + esc(j.property) + '</div><div>' + chip(j) + '</div></div>'; });
            h += '</div>';
            h += '<div class="callout">Dates save straight back to the renewals sheet in your Dropbox (Apps &gt; tim-property-renewals). Edit here to save immediately. After editing the sheet elsewhere, tap Refresh sheet. To update WhatsApp reminders, tap the button below and send the message to Instinct. Changing a date alone does not move reminders.</div>';
            h += '<div class="row" style="margin-top:12px"><a href="' + WA_LINK + '"><button class="primary">Update my reminders</button></a> <button onclick="pj.signout()">Sign out of Dropbox</button></div>';
        } else {
            var props = {};
            S.rows.forEach(function (j, i) { (props[j.property_id] = props[j.property_id] || { name: j.property, items: [] }).items.push(i); });
            Object.keys(props).forEach(function (pid) {
                var p = props[pid];
                if (pid === 'PORTFOLIO') return;
                var open = p.items.filter(function (i) { return status(S.rows[i]) !== 'done'; }).length;
                h += '<details class="prop"><summary>' + esc(p.name) + ' <span class="cnt">' + open + ' open</span></summary>';
                p.items.forEach(function (i) { h += jobHtml(i); });
                h += '<div class="job"><div class="row"><input type="text" id="newjob-' + esc(pid) + '" placeholder="Add your own job"> <button onclick="pj.add(\'' + esc(pid) + '\')">Add</button></div></div>';
                h += '</details>';
            });
            h += '<details class="prop"><summary>Whole portfolio</summary>';
            (props.PORTFOLIO ? props.PORTFOLIO.items : []).forEach(function (i) { h += jobHtml(i); });
            h += '</details>';
        }
        h += '<div class="foot">Master record: property-renewals.csv in your Dropbox app folder. Nothing is stored in this page; sign-in lasts until you close or reload the tab. Sources for the rules: GOV.UK Renters\' Rights Act overview, GOV.UK register your rental property, GOV.UK electrical safety standards, GOV.UK smoke and CO alarms, Blackpool Council selective licensing. Checked 15 Nov 2026.</div>';
        app.innerHTML = h;
    }

    function renderConnect() {
        app.innerHTML = '<h1>Your property jobs</h1><p class="sub">Rental renewals, live from your own sheet</p>'
            + '<div class="card"><p class="intro">Your renewal dates and jobs live in a sheet in your own Dropbox. This page reads and writes that sheet only after you connect - nothing is stored in the page itself.</p>'
            + '<p class="intro">Tap Connect, approve Dropbox access (it can only reach the app\'s own folder), and your jobs appear here. Edits save straight back to the sheet.</p>'
            + '<button class="primary" onclick="pj.connect()">Connect Dropbox</button></div>'
            + '<div class="foot">Reconnect after closing or reloading; Dropbox may ask you to sign in.</div>';
    }

    // Refresh only on the user's return to the tab, not by background polling.
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden && DbxSync.isConnected() && !S.saving) load(false);
    });

    window.addEventListener('focus', function () {
        if (DbxSync.isConnected() && !S.saving) load(false);
    });

    // ---------- boot ----------
    var r = DbxSync.handleReturn(function (name) {
        S.connectedAs = name; load(false);
    }, function (msg) {
        app.innerHTML = '<h1>Your property jobs</h1><div class="card err">' + esc(msg) + '</div><button class="primary" onclick="pj.connect()">Try again</button>';
    });
    if (r === 'idle') {
        if (DbxSync.isConnected()) { load(false); } else { renderConnect(); }
    } else {
        app.innerHTML = '<p class="status">Finishing Dropbox sign-in…</p>';
    }
})();
