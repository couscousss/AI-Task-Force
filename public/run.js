/**
 * Runs the balancing step in this browser and posts the result back.
 *
 * The solver is a pure module with no database or network access inside it, so it runs
 * identically here and on the server. It runs here because a Worker on Cloudflare's
 * free plan is cut off at 10ms of CPU per request, and balancing needs more than that.
 * The seed comes from the run, so the teams are the same either way.
 */
(function () {
  var el = document.getElementById('solve-here');
  if (!el) return;

  var runId = el.getAttribute('data-run-id');
  if (!runId) return;

  var statusEl = document.getElementById('solve-status');
  var noJsEl = document.getElementById('solve-nojs');
  if (noJsEl) noJsEl.hidden = true;

  function say(text, tone) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = tone ? 'callout callout-' + tone : 'small muted';
  }

  function fail(message) {
    say(message, null);
    if (!statusEl) return;
    statusEl.className = 'error-text';
    // Stop the page's meta refresh from hiding the message a moment later.
    var meta = document.querySelector('meta[http-equiv="refresh"]');
    if (meta && meta.parentNode) meta.parentNode.removeChild(meta);
  }

  // The page meta-refreshes every 2s while a run is in progress; without this the
  // solve could be started twice in quick succession by two overlapping loads.
  try {
    if (sessionStorage.getItem('solving-' + runId) === '1') return;
    sessionStorage.setItem('solving-' + runId, '1');
  } catch (e) {
    /* private mode; carrying on is safe because the server rejects a second result */
  }

  function clearLock() {
    try {
      sessionStorage.removeItem('solving-' + runId);
    } catch (e) {
      /* nothing to do */
    }
  }

  say('Reading the problem statements…');

  fetch('/admin/runs/' + encodeURIComponent(runId) + '/solve-input', {
    headers: { accept: 'application/json' },
  })
    .then(function (res) {
      if (res.status === 409) return null; // already balanced, or not our turn
      if (!res.ok) throw new Error('could not load this run (' + res.status + ')');
      return res.json();
    })
    .then(function (input) {
      if (!input) {
        clearLock();
        return null;
      }
      if (!window.BuilderDaySolver || !window.BuilderDaySolver.solve) {
        throw new Error('the balancing code did not load');
      }
      var n = input.participants.length;
      say('Balancing ' + n + ' ' + (n === 1 ? 'person' : 'people') + ' into teams…');

      // Yield a frame so the message above actually paints before we block the thread.
      return new Promise(function (resolve) {
        setTimeout(function () {
          var started = Date.now();
          var result = window.BuilderDaySolver.solve(input);
          resolve({ result: result, ms: Date.now() - started });
        }, 30);
      });
    })
    .then(function (solved) {
      if (!solved) return null;
      var teams = solved.result.teams;
      say('Naming ' + teams.length + ' teams…');
      return fetch('/admin/runs/' + encodeURIComponent(runId) + '/solve-result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teams: teams, theme_of: solved.result.theme_of }),
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body && body.error ? body.error : 'the teams could not be saved');
          return true;
        });
      });
    })
    .then(function (done) {
      if (done) {
        clearLock();
        window.location.reload();
      }
    })
    .catch(function (err) {
      clearLock();
      fail(
        'The teams could not be built: ' +
          (err && err.message ? err.message : 'something went wrong') +
          '. Reload this page to try again, or export the participants to CSV and group by hand.',
      );
    });
})();
