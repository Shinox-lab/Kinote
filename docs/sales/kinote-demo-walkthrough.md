# Kinote demo walkthrough

**For:** the person showing Kinote to a prospect.

**Time:** 20–30 minutes.

**Story in one line:** *Write it down once. Kinote files it everywhere it belongs, and your team stays in control.*

---

## Before the call

1. Set up a fresh demo workspace with `pnpm seed:demo`, or fill an empty one with
   `pnpm seed:demo --into <workspace> --email <you>`. It takes about two minutes.
2. Keep the list of accounts it prints. Everyone it creates uses the password `correct-horse-battery`.
   | Person | Role in the demo |
   |---|---|
   | Priya Shah (or you) | Owner of **Northwind Studio**, a small design studio |
   | Tomás Reyes, Jonah Okafor | Editors |
   | Mei Lin | Reviewer for the **Clients** space |
3. Open two browser windows side by side: one signed in as the owner, and a private window for a colleague.
4. Wait a minute after setup before the first capture. Kinote is still reading the pages in the background.

> **Set expectations.** Capture and Ask use a real AI model, so the wording can differ a little from run to run. That
> is a selling point: nothing here is scripted.

---

## The walkthrough

### 1. A wiki that's already full (2 min)
**Do:** Open **Home**, then expand the three spaces in the sidebar: **Engineering**, **Clients** and **Handbook**.

**Say:** "This is Northwind Studio: client pages, a roadmap, an employee handbook. Clients is a space where every
change needs a reviewer. The others are open."

### 2. Capture: write it down once (5 min) *(the main moment)*
**Do:**
1. Click **Capture** in the sidebar.
2. Paste: *"Call with Harbor & Co today: launch moves from 14 Nov to 28 Nov, and Daniel Cho takes over from Ruth
   Alvarez as their main contact. Let's pause the checkout redesign until their new brand guide arrives."*
3. Set **File as** to **Updates only**, then click **Send**.
4. When it says **Done**, walk through the receipt.


**Point out:**
- It changed **two pages in two spaces**: the Harbor & Co client page (launch date and contact) and the **Checkout
  redesign** roadmap item (status now **Blocked**).
- Every change has a **Why here:** reason, its own **Undo**, and **Wrong page → move to…**
- The client page shows **Waiting for review**, because AI changes to Clients wait for a person.
- If Kinote asks a follow-up question, answer it. It asks rather than guesses.


**Say:** "Nobody had to remember which pages to update, or where they live. You wrote one note."

### 3. Review: people stay in control (3 min)
**Do:** In the private window, sign in as **Mei Lin**. Open **Reviews**, choose **Harbor & Co**, switch to **Changes
only**, and click **Approve**. Back in the owner's window, open Harbor & Co: the status reads **Indexed · v2**.

**Say:** "Sensitive spaces get a second pair of eyes. The AI proposes and a person approves. Anyone can open
**History** and restore an older version."

### 4. Edit together, live (2 min)
**Do:** Open **Engineering → Design review notes** in both windows (owner and Tomás or Jonah). Type in both at once.

**Point out:** each person's named cursor, and text appearing live. AI agents edit the same way.

### 5. Search and Ask (3 min)
**Do:** Click **Search**, type *How many vacation days do new hires get?*, press Enter, then click **Get an answer**.

**Point out:** the answer (22 days) and its **Sources**. Click the first source to open **Time off** at the right
place.

**Say:** "Answers only come from your own pages, with the source one click away. If the wiki doesn't know, it says so."

### 6. Files you can search (3 min)
**Do:** In **Engineering**, open **Harbor & Co brand guide.pdf**, then **Q4 budget.xlsx**. Then search for
*Tidewater Blue*.

**Point out:** previews in the page, the search hit inside the PDF, and **Edit in GridCraft** on the spreadsheet,
which saves a new version.

### 7. Collections and views (3 min)
**Do:** Open **Engineering → Roadmap**. On an empty line at the bottom, type `/collection view` and choose
**Collection view**. Then use **+ Add a view** to switch to **Board** and drag a card to **Blocked**. Add
**Calendar** and **Timeline** too.

**Say:** "Ten projects, one set of pages, four ways to look at them. No separate project tool."

### 8. Drawings, links and comments (3 min)
**Do:**
- In **Handbook → Office layout**, type `/drawing`, click inside the drawing, then sketch with **R** (rectangle), **A** (arrow) and **T** (text).
- In **Engineering → Weekly notes**, type `[[Harb` and pick **Harbor & Co**. Click the link to open the side
  preview.
- On a page, select a few words, click **Add comment**, write something and click **Save**.

### 9. Make it yours (1 min)
**Do:** On any page, open the **…** menu at the top right and set **Width** to **Wide** or **Full**.

**Show:** **Settings & members**, with workspace roles (owner, admin, member, viewer) and per-space roles (viewer,
editor, reviewer, admin).

---

## Closing

- **Self-hosted or hosted.** Kinote runs on your own servers with Docker Compose, with your choice of AI model
  provider. A hosted version is coming soon.
- **Open source** under the MIT licence.
- **What's next.** Be clear these are **(In development)**, not available today: WhatsApp groups as a source, Google
  Drive sync, MCP for external AI agents, a self-maintaining wiki, and space export to Markdown.

## Handling questions

| They ask | Answer |
|---|---|
| "What if the AI files something wrong?" | Every change has **Undo** and **Wrong page → move to…**, and review spaces hold AI changes for approval. |
| "Can it see everything?" | Search, Ask and AI changes only reach the spaces a person or agent has access to. Workspaces are kept apart in the database itself. |
| "Where does our data go?" | You choose the model provider, or run your own. Self-hosting keeps everything on your servers. |
| "What does the receipt show?" | Each page changed, what changed, why it chose that page, and buttons to undo or move it. |

**Reset for the next demo:** run `pnpm seed:demo` again for a clean workspace.
