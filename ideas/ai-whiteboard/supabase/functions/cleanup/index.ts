// THIS FILE IS FOR: the scheduled cleanup Edge Function (build plan 1.12). Needs the AI_CRON_SECRET bearer. Logic lives in ../_shared.
import { hostedDeps } from '../_shared/hosted.ts';
import { cleanupHandler } from '../_shared/http.mjs';

Deno.serve(cleanupHandler(hostedDeps()));
