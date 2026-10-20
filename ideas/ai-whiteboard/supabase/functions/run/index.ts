// THIS FILE IS FOR: the /run Edge Function (build plan 1.11). The logic lives in ../_shared; this only starts it with the hosted wiring.
import { hostedDeps } from '../_shared/hosted.ts';
import { runHandler } from '../_shared/http.mjs';

Deno.serve(runHandler(hostedDeps()));
