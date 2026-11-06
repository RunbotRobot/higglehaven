      // #1603: owner reported the post-email-verification confirmation
      // modal rendering tiny/unreadable, suspected Gmail-link-specific.
      // Most likely cause: #1504/#1509 (merged 3 days earlier) deliberately
      // stopped locking the whole document to initial-scale=1.0 (it used to
      // carry user-scalable=no/maximum-scale=1.0 site-wide, which blocked
      // pinch-zoom on every text-heavy modal for a legitimate a11y reason —
      // see that issue). Several mobile in-app browsers, including
      // WKWebView-based link viewers like Gmail's on iOS, carry a tab's
      // existing pinch-zoom level into a fresh same-origin navigation
      // instead of resetting to the new page's own initial-scale — so a
      // page reached via an emailed link can land already zoomed out if
      // that browser tab had been pinch-zoomed at some earlier point.
      // Rewriting the viewport meta's content on load (even back to the
      // same value) forces the browser to recompute the effective scale
      // from initial-scale=1.0 instead of whatever it inherited, without
      // re-disabling pinch-zoom for the rest of the session.
      (function () {
        var viewport = document.querySelector('meta[name="viewport"]');
        if (!viewport) return;
        var original = viewport.getAttribute('content');
        viewport.setAttribute('content', original + ', maximum-scale=1');
        requestAnimationFrame(function () {
          viewport.setAttribute('content', original);
        });
      })();
