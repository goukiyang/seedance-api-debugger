'use strict';
// Must execute before the HD worker's lazy imports or any database access.
if (process.env.SD2_DATABASE_MODE !== 'readonly') throw new Error('hd_readonly_process_mode_required');
