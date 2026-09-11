/* Team review board. Everything here is an enhancement: with JavaScript off each chip
   carries a plain <select> + Move button that posts a single move to the server, and the
   board is fully usable. This file only makes the same moves faster and re-checks the
   constraints as you go — the server remains the only place a rule is evaluated. */
(function () {
  'use strict';

  var board = document.getElementById('board');
  var arrangementInput = document.getElementById('arrangement');
  var form = document.getElementById('board-form');
  var status = document.getElementById('validate-status');
  var violationsBox = document.getElementById('board-violations');
  var dataEl = document.getElementById('review-data');
  if (!board || !arrangementInput || !form || !dataEl) return;

  var config;
  try {
    config = JSON.parse(dataEl.textContent || '{}');
  } catch (e) {
    return;
  }
  if (!config || !config.validateUrl) return;

  /* The no-JS move controls are now redundant; drag-and-drop and the keyboard path
     below cover the same ground without a page load each time. */
  var nojs = board.querySelectorAll('[data-nojs-move]');
  for (var i = 0; i < nojs.length; i++) {
    // `hidden` alone loses to the .chip-meta display rule, so set both.
    nojs[i].hidden = true;
    nojs[i].style.display = 'none';
  }

  var chips = board.querySelectorAll('.chip');
  for (var j = 0; j < chips.length; j++) prepareChip(chips[j]);

  function prepareChip(chip) {
    chip.setAttribute('tabindex', '0');
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-pressed', 'false');
    var name = chip.getAttribute('data-person-name') || 'this person';
    chip.setAttribute('aria-label', name + ' — press Enter to pick up, then Enter on a team to drop');
  }

  function say(text) {
    if (status) status.textContent = text;
  }

  function teamName(section) {
    if (!section) return 'a team';
    var h = section.querySelector('h3');
    return h ? h.textContent.trim() : 'a team';
  }

  /* ---------------------------------------------------------------- state */

  var dirty = false;
  var selected = null;

  window.addEventListener('beforeunload', function (e) {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
  form.addEventListener('submit', function () {
    dirty = false;
  });

  function readBoard() {
    var out = { teams: [], unassigned: [], sections: [] };
    var sections = board.querySelectorAll('.team');
    for (var k = 0; k < sections.length; k++) {
      var section = sections[k];
      var ids = [];
      var list = section.querySelectorAll('.chip');
      for (var m = 0; m < list.length; m++) {
        var id = list[m].getAttribute('data-participant-id');
        if (id) ids.push(id);
      }
      var indexAttr = section.getAttribute('data-team-index');
      if (indexAttr === null) {
        out.unassigned = ids;
      } else {
        out.teams.push({
          index: Number(indexAttr),
          team_id: section.getAttribute('data-team-key') || '',
          theme_label: section.getAttribute('data-theme-label') || '',
          member_ids: ids,
        });
      }
      out.sections.push({ section: section, count: ids.length });
    }
    return out;
  }

  function syncCounts(state) {
    var placed = 0;
    for (var k = 0; k < state.sections.length; k++) {
      var entry = state.sections[k];
      var counter = entry.section.querySelector('[data-team-count]');
      if (counter) counter.textContent = entry.count + (entry.count === 1 ? ' person' : ' people');
      if (entry.section.getAttribute('data-team-index') !== null) placed += entry.count;
    }
    var placedStat = document.querySelector('[data-live="placed"] .stat-hint');
    if (placedStat) {
      placedStat.textContent = placed + ' placed, ' + state.unassigned.length + ' unassigned';
    }
    arrangementInput.value = JSON.stringify({
      teams: state.teams.map(function (t) {
        return { team_id: t.team_id, member_ids: t.member_ids };
      }),
      unassigned: state.unassigned,
    });
  }

  /* ---------------------------------------------------------------- validate */

  var timer = null;
  var requestId = 0;

  function scheduleValidate(prefix) {
    if (timer) clearTimeout(timer);
    say(prefix ? prefix + ' Checking…' : 'Checking…');
    timer = setTimeout(runValidate, 250);
  }

  function runValidate() {
    var state = readBoard();
    var mine = ++requestId;
    fetch(config.validateUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        teams: state.teams.map(function (t) {
          return { index: t.index, theme_label: t.theme_label, member_ids: t.member_ids };
        }),
      }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (evaluation) {
        if (mine !== requestId) return; // a newer move has already been sent
        paint(evaluation);
      })
      .catch(function () {
        if (mine !== requestId) return;
        say(
          'Could not re-check with the server, so the notes below are from before your last move. ' +
            'Check your connection, or press Save changes and reload the page.',
        );
      });
  }

  function paint(evaluation) {
    if (!evaluation || !evaluation.score) return;
    var perTeam = evaluation.per_team || {};
    var sections = board.querySelectorAll('.team[data-team-index]');
    for (var k = 0; k < sections.length; k++) {
      var section = sections[k];
      var issues = perTeam[section.getAttribute('data-team-index')] || [];
      var holder = section.querySelector('[data-team-status]');
      if (holder) replaceChildren(holder, issues.length ? issueList(issues) : okLine('Meets every rule'));
      if (issues.length) section.classList.add('is-invalid');
      else section.classList.remove('is-invalid');
    }

    var violations = evaluation.violations || [];
    if (violationsBox) {
      replaceChildren(
        violationsBox,
        violations.length
          ? violationList(violations)
          : okLine('Team sizes, laptops, builders and skill mix all check out.'),
      );
    }

    setText('[data-live="score"] .stat-value', two(evaluation.score.weighted_total));
    setText('[data-live="violations"] .stat-value', String(violations.length));
    var keys = ['theme_cohesion', 'skill_diversity', 'across_team_balance', 'category_match', 'department_mixing'];
    for (var n = 0; n < keys.length; n++) {
      setText('[data-score-key="' + keys[n] + '"]', two(evaluation.score[keys[n]]));
    }

    say(
      violations.length === 0
        ? 'Checked just now — every rule is satisfied.'
        : 'Checked just now — ' +
            violations.length +
            (violations.length === 1 ? ' rule is' : ' rules are') +
            ' not satisfied.',
    );
  }

  function two(v) {
    return typeof v === 'number' && isFinite(v) ? v.toFixed(2) : '—';
  }

  function setText(selector, text) {
    var el = document.querySelector(selector);
    if (el) el.textContent = text;
  }

  function replaceChildren(parent, node) {
    while (parent.firstChild) parent.removeChild(parent.firstChild);
    parent.appendChild(node);
  }

  function okLine(text) {
    var p = document.createElement('p');
    p.className = 'team-ok';
    p.textContent = text;
    return p;
  }

  function issueList(messages) {
    var ul = document.createElement('ul');
    ul.className = 'team-issues';
    for (var k = 0; k < messages.length; k++) {
      var li = document.createElement('li');
      li.textContent = String(messages[k]);
      ul.appendChild(li);
    }
    return ul;
  }

  function violationList(violations) {
    var ul = document.createElement('ul');
    ul.className = 'team-issues';
    for (var k = 0; k < violations.length; k++) {
      var v = violations[k] || {};
      var li = document.createElement('li');
      var tag = document.createElement('span');
      tag.className = 'tag tag-no';
      tag.textContent = String(v.code || '');
      li.appendChild(tag);
      li.appendChild(document.createTextNode(' ' + String(v.message || '').replace(/^H[1-4]:\s*/, '')));
      ul.appendChild(li);
    }
    return ul;
  }

  /* ---------------------------------------------------------------- moving */

  function moveChip(chip, section) {
    var list = section.querySelector('[data-chips]');
    if (!list || !chip || chip.parentNode === list) return false;
    list.appendChild(chip);
    dirty = true;
    syncCounts(readBoard());
    return true;
  }

  function afterMove(chip, section) {
    var who = chip.getAttribute('data-person-name') || 'That person';
    scheduleValidate('Moved ' + who + ' to ' + teamName(section) + '.');
  }

  /* Drag for pointer users. */
  board.addEventListener('dragstart', function (e) {
    var chip = e.target && e.target.closest ? e.target.closest('.chip') : null;
    if (!chip) return;
    chip.classList.add('is-dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', chip.getAttribute('data-participant-id') || '');
    }
  });

  board.addEventListener('dragend', function (e) {
    var chip = e.target && e.target.closest ? e.target.closest('.chip') : null;
    if (chip) chip.classList.remove('is-dragging');
    clearDropTargets();
  });

  board.addEventListener('dragover', function (e) {
    var section = e.target && e.target.closest ? e.target.closest('.team') : null;
    if (!section) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    clearDropTargets();
    section.classList.add('is-drop-target');
  });

  board.addEventListener('drop', function (e) {
    var section = e.target && e.target.closest ? e.target.closest('.team') : null;
    if (!section) return;
    e.preventDefault();
    clearDropTargets();
    var id = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
    var chip = id ? board.querySelector('.chip[data-participant-id="' + cssEscape(id) + '"]') : null;
    if (!chip) return;
    chip.classList.remove('is-dragging');
    if (moveChip(chip, section)) afterMove(chip, section);
  });

  function clearDropTargets() {
    var targets = board.querySelectorAll('.team.is-drop-target');
    for (var k = 0; k < targets.length; k++) targets[k].classList.remove('is-drop-target');
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  /* Keyboard: pick a person up with Enter or Space, drop them on a team with Enter. */
  board.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && selected) {
      deselect();
      say('Put back. Nothing moved.');
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;

    var chip = e.target && e.target.closest ? e.target.closest('.chip') : null;
    var section = e.target && e.target.closest ? e.target.closest('.team') : null;

    if (chip && !selected) {
      e.preventDefault();
      select(chip);
      return;
    }
    if (chip && chip === selected) {
      e.preventDefault();
      deselect();
      say('Put back. Nothing moved.');
      return;
    }
    // With someone picked up, Enter anywhere inside a team drops them onto that team.
    if (selected && section && e.key === 'Enter') {
      e.preventDefault();
      var moving = selected;
      var moved = moveChip(moving, section);
      deselect();
      moving.focus();
      if (moved) afterMove(moving, section);
      else say('Already on ' + teamName(section) + '. Nothing moved.');
    }
  });

  function select(chip) {
    selected = chip;
    chip.classList.add('is-selected');
    chip.setAttribute('aria-pressed', 'true');
    var sections = board.querySelectorAll('.team');
    for (var k = 0; k < sections.length; k++) sections[k].setAttribute('tabindex', '0');
    say(
      'Picked up ' +
        (chip.getAttribute('data-person-name') || 'that person') +
        '. Tab to a team and press Enter to drop them there, or press Escape to put them back.',
    );
  }

  function deselect() {
    if (selected) {
      selected.classList.remove('is-selected');
      selected.setAttribute('aria-pressed', 'false');
    }
    selected = null;
    var sections = board.querySelectorAll('.team');
    for (var k = 0; k < sections.length; k++) sections[k].removeAttribute('tabindex');
  }

  syncCounts(readBoard());
})();
