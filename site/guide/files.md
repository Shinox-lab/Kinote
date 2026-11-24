# Files

<ClipVideo name="files" label="A PDF and a spreadsheet are uploaded, previewed and found by search" />

Keep the files your team works from next to your pages: PDFs, Word documents, slide decks, spreadsheets, CSVs, images,
and text or Markdown files. Kinote shows a preview, reads the text inside, and makes it searchable.

## Upload a file

1. Hover a space or page in the sidebar and click **+**.
2. Choose **Upload file** and pick one or more files.

You can also drop files onto a page while you're writing, or attach one to a capture. Uploads keep going while you move
to another screen, and their progress shows in the sidebar.

Once it's uploaded, the file shows **Reading text…** while Kinote reads it, then **Indexed · v1** when search can find
it. In a space with review on, a new file or a new version of one waits for a reviewer, like a page.

## Previews

Click a file to open it.

- **PDFs** open as pages. A search result that points into a PDF opens it on the right page.
- **Spreadsheets** open as a table with one tab per sheet. CSV files open as a table too.
- **Word documents** and **slide decks** open as their text.
- **Images**, **text** and **Markdown** files open in place.

If a file can't be shown, Kinote offers it as a download instead.

## The spreadsheet editor

You can edit an uploaded spreadsheet (`.xlsx`) without leaving Kinote.

1. Open the spreadsheet and click **Edit in GridCraft**.
2. Make your changes. **Full screen** gives you more room.
3. Save. Kinote stores it as a new version of the file and reads it again, so search stays up to date.

Viewers, and older versions of a file, open read-only. If you try to leave with unsaved changes, Kinote asks first.

## Versions

Upload a file again to add a new version. The file's page lists every version with its status, who added it, its size
and when. While a new version waits for review, the previous one keeps answering search.

Viewers see the version that was last approved. A file with no text to read, such as a photo, a recording or a video,
opens for viewers too once it's approved.

## Agents and files

An AI agent connected to Kinote works with files the way it works with pages, and only in the spaces it was given.

- **Look before it changes anything.** The agent reads a file's info first: its type, size, current version and
  which tools can change it. A viewer agent is told the file is view only.
- **Download.** The agent gets a link to the file that works for 15 minutes and only for that agent, with a ready
  `curl` line. Small text files and images also come back in the reply itself.
- **Replace.** After changing its copy, the agent sends it back as a new version and names the version it started
  from. If someone changed the file in the meantime, Kinote refuses and says who changed it and when, so the agent
  downloads it again and redoes the change. A large file goes up through a one-time upload link; nothing changes until
  the agent confirms it.
- **Review.** A new version from an agent waits for review like a page edit, and you can approve it in Kinote or in
  the review panel of your AI client, which shows the two versions' sizes, their text or a preview of an image.

An agent can't replace audio or video, change a file's type, or change a file a connected source manages.
