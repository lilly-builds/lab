// THIS FILE IS FOR: the /route Edge Function (build plan 1.10). The logic lives in ../_shared; this only starts it with the hosted wiring.
import { hostedDeps } from '../_shared/hosted.ts';
import { routeHandler } from '../_shared/http.mjs';

Deno.serve(routeHandler(hostedDeps()));
