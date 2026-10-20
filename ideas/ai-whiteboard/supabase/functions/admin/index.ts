// THIS FILE IS FOR: Lilly's admin Edge Function (build plan 1.8, 1.12). Needs the AI_ADMIN_SECRET bearer. Logic lives in ../_shared.
import { hostedDeps } from '../_shared/hosted.ts';
import { adminHandler } from '../_shared/http.mjs';

Deno.serve(adminHandler(hostedDeps()));
