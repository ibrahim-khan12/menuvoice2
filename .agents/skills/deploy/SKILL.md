# Deploy Skill

Runs the full deployment checklist for MenuVoice (Vercel via GitHub auto-deploy).

## Steps

1. **Verify whitelisted OAuth origin matches deploy URL**
   - Open the Google Cloud Console (or whichever OAuth provider is in use) and confirm the authorized redirect/origin URI exactly matches the live Vercel deployment URL (e.g. `https://menuvoice2.vercel.app`).
   - If a preview or custom domain is being targeted, update the whitelist before pushing.

2. **Confirm non-VITE env vars are set in Vercel**
   - In the Vercel project dashboard → Settings → Environment Variables, verify server-side secrets use the bare name (e.g. `OPENAI_API_KEY`, not `VITE_OPENAI_API_KEY`).
   - `VITE_` prefixed vars are exposed to the client bundle; server functions only receive non-prefixed vars.
   - Check every key referenced in `/api` or server functions is present and has a non-empty value for the target environment (Production / Preview).

3. **Run a clean build locally**
   ```
   npm run build
   ```
   Confirm no errors and that `dist/` is produced without warnings that would break the deployed app.

4. **Push to GitHub**
   ```
   git push origin main
   ```
   Vercel auto-deploy triggers on push to `main`. Watch the Vercel dashboard for the deployment to go live and confirm the deployment succeeds.

## Usage

Type `/deploy do` in the Codex prompt to run this checklist interactively.
