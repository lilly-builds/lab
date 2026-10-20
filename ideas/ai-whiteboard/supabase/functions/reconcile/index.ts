// THIS FILE IS FOR: the scheduled reconcile Edge Function (build plan 1.12). Needs the AI_CRON_SECRET bearer. Logic lives in ../_shared.
import { hostedDeps } from '../_shared/hosted.ts';
import { reconcileHandler } from '../_shared/http.mjs';

Deno.serve(reconcileHandler(hostedDeps()));
