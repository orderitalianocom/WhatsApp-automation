// Root entrypoint required by Vercel's build detection (looks for a root
// file that imports express). The real app lives in api/index.js (Supabase-based).
import express from "express";
export { default } from "./api/index.js";
