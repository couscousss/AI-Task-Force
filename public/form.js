/* Progressive enhancement for the check-in form. Everything here is optional: with
   JavaScript off the form behaves identically, and the server is the only authority on
   what is required. Anything missing from the page is a silent no-op. */
(function () {
  'use strict';

  var form = document.getElementById('checkin-form');
  if (!form) return;

  /* 1. A decline needs nothing below the email, so fold that section away.
        Hidden fields still submit, so an existing answer is never lost by declining. */
  var details = document.getElementById('attending-details');
  var attending = form.querySelectorAll('input[name="attending"]');

  function syncAttending() {
    if (!details) return;
    var declined = false;
    for (var i = 0; i < attending.length; i++) {
      if (attending[i].checked && attending[i].value === '0') declined = true;
    }
    details.hidden = declined;
  }

  for (var i = 0; i < attending.length; i++) {
    attending[i].addEventListener('change', syncAttending);
  }
  syncAttending();

  /* 2. Live length hint on the problem statement. It never blocks typing and never
        changes what can be submitted — it just saves a round trip to the server. */
  var textarea = document.getElementById('problem_statement');
  var counter = document.getElementById('problem_count');
  var MIN_CHARS = 40;

  function syncCount() {
    if (!textarea || !counter) return;
    var length = textarea.value.replace(/\s+/g, ' ').trim().length;
    if (length === 0) {
      counter.hidden = true;
      counter.textContent = '';
      return;
    }
    counter.hidden = false;
    counter.textContent =
      length < MIN_CHARS
        ? MIN_CHARS - length + ' more characters and this is enough to work with'
        : length + ' characters — that is enough';
  }

  if (textarea && counter) {
    textarea.addEventListener('input', syncCount);
    syncCount();
  }
})();
