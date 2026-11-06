# MJ preview controller

Controller for the existing same-origin SD2 style preview. A opens the authenticated Works page; B opens the authenticated image template workbench. The normal application remains the content and permission source.

Explicit nginx 502/503/504 documents show reconnect feedback and receive at most three read-only readiness probes. Only the failed iframe document is reopened with GET. Healthy pages, drafts, generation and business operations are never retried. Switching pages cancels a pending reconnect.

The controller is published as a versioned compare script with the existing preview HTML/CSS. Source styles remain on the A/B candidate branches; private reference images and incident evidence stay outside the public artifacts.

Authentication is never shown inside the iframe. A user-activated top-level original login preserves the selected sample and viewport in its same-origin return path. Existing CSP and OAuth/state permissions remain unchanged.

C opens the original /generate video generation page. Its route-only candidate stylesheet is scoped by .mj-generation-page, which the comparison controller adds only to that iframe root. Formal app styles, APIs and submission logic are unchanged. A/B styles remain on their original branches. The r05-generation HTML references versioned controller and chrome assets; r04 files remain available to existing open documents.

The r06 C preview additionally loads ux.js/css: a presentation adapter for the resource picker, Feishu notice and project section. It groups duplicate folder names without changing albums, keeps original React-owned controls in place, and adds only its own disclosure buttons and data attributes. Source share records, actual files, permissions and all business handlers remain unchanged. Image generation follows after these two UX work packages.
