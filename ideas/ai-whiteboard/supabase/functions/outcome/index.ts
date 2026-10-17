// THIS FILE IS FOR: the /outcome Edge Function (build plan 1.20): what a person did with an answer, as a code. Logic lives in ../_shared.
import { hostedDeps } from '../_shared/hosted.ts';
import { outcomeHandler } from '../_shared/http.mjs';

Deno.serve(outcomeHandler(hostedDeps()));
