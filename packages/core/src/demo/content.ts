// The Northwind Studio demo workspace: data only. Everyone and everything here is invented.

export type PersonKey = 'priya' | 'tomas' | 'mei' | 'jonah';
export type SpaceKey = 'engineering' | 'clients' | 'handbook';

export const workspace = { name: 'Northwind Studio', slug: 'northwind' };

export const people: Record<PersonKey, { name: string }> = {
  priya: { name: 'Priya Shah' },
  tomas: { name: 'Tomás Reyes' },
  mei: { name: 'Mei Lin' },
  jonah: { name: 'Jonah Okafor' },
};

export const spaces: Record<SpaceKey, { name: string; reviewRequired: boolean }> = {
  engineering: { name: 'Engineering', reviewRequired: false },
  clients: { name: 'Clients', reviewRequired: true },
  handbook: { name: 'Handbook', reviewRequired: false },
};

export type Status = 'planned' | 'progress' | 'blocked' | 'shipped';

export interface PageSeed {
  key: string;
  space: SpaceKey;
  title: string;
  markdown: string;
  parent?: string;
  /** Who writes it; the owner when absent. */
  by?: PersonKey;
  /** Roadmap rows only. */
  row?: { status: Status; owner: PersonKey; start: string; end: string };
}

export const roadmapFields = {
  status: {
    name: 'Status',
    choices: [
      { id: 'planned', name: 'Planned', color: 'gray' },
      { id: 'progress', name: 'In progress', color: 'blue' },
      { id: 'blocked', name: 'Blocked', color: 'red' },
      { id: 'shipped', name: 'Shipped', color: 'green' },
    ],
  },
  owner: { name: 'Owner' },
  dates: { name: 'Dates' },
} as const;

export const pages: PageSeed[] = [
  // --- Clients (review on) -------------------------------------------------
  {
    key: 'harbor',
    space: 'clients',
    title: 'Harbor & Co',
    markdown: `Harbor & Co sell outdoor furniture online. We're rebuilding their shop and checkout.

## Contact
- Main contact: Ruth Alvarez, Head of Digital
- Billing: accounts@harborco.example

## Launch
- The new shop launches on **14 November**.
- Before launch they owe us their updated brand guide (colours, type, photography).

## Notes
- They want the checkout to feel "as calm as the showroom".
- Weekly check-in on Thursdays at 10:00.`,
  },
  {
    key: 'lumen',
    space: 'clients',
    title: 'Lumen Health',
    markdown: `Lumen Health run three physiotherapy clinics. We design their booking app.

## Contact
- Main contact: Sam Whitaker, Operations Lead

## Scope
- Booking flow for new and returning patients
- Reminders by text message
- A simple dashboard for front-desk staff

## Status
- Design sign-off is planned for early December.`,
  },
  {
    key: 'fernwood',
    space: 'clients',
    title: 'Fernwood Bakery',
    markdown: `Fernwood Bakery have four shops and want online pre-orders for weekends.

## Contact
- Main contact: Owen Price, owner

## What we agreed
- Pre-orders close at 18:00 the day before.
- Collection only, no delivery, for the first release.
- Their menu changes every season, so staff must be able to edit it without us.`,
  },
  {
    key: 'atlas',
    space: 'clients',
    title: 'Atlas Freight',
    markdown: `Atlas Freight track shipping containers for small importers.

## Contact
- Main contact: Lena Fischer, Product Manager

## Scope
- A redesign of their tracking page, mobile first
- Clearer delay notices

## Open questions
- Do they want email alerts in this phase, or the next one?`,
  },
  {
    key: 'onboarding',
    space: 'clients',
    title: 'How we onboard a client',
    markdown: `1. Kick-off call: goals, contacts, budget and dates.
2. Make a page for the client in this space with the main contact and the launch date.
3. Share a project board and add their milestones to the Roadmap.
4. Agree on a weekly check-in.
5. Ask for their brand guide in the first week. Most delays start here.`,
  },

  // --- Engineering -----------------------------------------------------------
  {
    key: 'roadmap',
    space: 'engineering',
    title: 'Roadmap',
    by: 'tomas',
    markdown: `What the studio is building this quarter, one page per piece of work.

Every item has a status, an owner and dates. Update the status when work moves, and add a note on the item's page when
something changes.`,
  },
  {
    key: 'checkout',
    space: 'engineering',
    parent: 'roadmap',
    title: 'Checkout redesign',
    by: 'tomas',
    row: { status: 'progress', owner: 'tomas', start: '2026-10-19', end: '2026-11-13' },
    markdown: `The new checkout for Harbor & Co: one page instead of four, with saved addresses.

- Payment step built and tested
- Waiting on final colours from their brand guide`,
  },
  {
    key: 'booking',
    space: 'engineering',
    parent: 'roadmap',
    title: 'Lumen booking flow',
    by: 'jonah',
    row: { status: 'progress', owner: 'jonah', start: '2026-10-26', end: '2026-12-04' },
    markdown: `Booking for new and returning patients at Lumen Health.

- Returning patients skip the health questions
- Front desk can move a booking without calling the patient`,
  },
  {
    key: 'preorders',
    space: 'engineering',
    parent: 'roadmap',
    title: 'Fernwood pre-orders',
    by: 'jonah',
    row: { status: 'planned', owner: 'jonah', start: '2026-11-16', end: '2026-12-18' },
    markdown: `Weekend pre-orders for Fernwood Bakery, collection only.`,
  },
  {
    key: 'tracking',
    space: 'engineering',
    parent: 'roadmap',
    title: 'Atlas tracking page',
    by: 'tomas',
    row: { status: 'planned', owner: 'tomas', start: '2026-11-23', end: '2026-12-23' },
    markdown: `Mobile-first tracking page for Atlas Freight, with clearer delay notices.`,
  },
  {
    key: 'design-system',
    space: 'engineering',
    parent: 'roadmap',
    title: 'Design system v2',
    by: 'mei',
    row: { status: 'shipped', owner: 'mei', start: '2026-10-01', end: '2026-10-23' },
    markdown: `Shared buttons, forms and colour tokens for every client project. Shipped and in use.`,
  },
  {
    key: 'reminders',
    space: 'engineering',
    parent: 'roadmap',
    title: 'Text message reminders',
    by: 'jonah',
    row: { status: 'blocked', owner: 'jonah', start: '2026-11-02', end: '2026-11-20' },
    markdown: `Appointment reminders for Lumen Health. Blocked until they choose a text message provider.`,
  },
  {
    key: 'staging',
    space: 'engineering',
    parent: 'roadmap',
    title: 'Staging environments',
    by: 'tomas',
    row: { status: 'shipped', owner: 'tomas', start: '2026-10-05', end: '2026-10-16' },
    markdown: `One staging site per client, rebuilt on every merge.`,
  },
  {
    key: 'accessibility',
    space: 'engineering',
    parent: 'roadmap',
    title: 'Accessibility audit',
    by: 'mei',
    row: { status: 'progress', owner: 'mei', start: '2026-11-02', end: '2026-11-27' },
    markdown: `Keyboard and screen reader checks across all live client sites.`,
  },
  {
    key: 'analytics',
    space: 'engineering',
    parent: 'roadmap',
    title: 'Privacy-friendly analytics',
    by: 'priya',
    row: { status: 'planned', owner: 'priya', start: '2026-12-01', end: '2026-12-18' },
    markdown: `Replace third-party trackers with simple, cookie-free page counts.`,
  },
  {
    key: 'handover',
    space: 'engineering',
    parent: 'roadmap',
    title: 'Client handover kit',
    by: 'priya',
    row: { status: 'planned', owner: 'priya', start: '2026-12-07', end: '2026-12-22' },
    markdown: `A short guide and a recorded walkthrough we give every client at launch.`,
  },
  {
    key: 'design-review',
    space: 'engineering',
    title: 'Design review notes',
    by: 'mei',
    markdown: `Notes from the Friday design review. Newest first.

## 23 October
- Harbor & Co checkout: the order summary moves to the right on desktop.
- Lumen booking: test the date picker with older patients before sign-off.`,
  },
  {
    key: 'weekly',
    space: 'engineering',
    title: 'Weekly notes',
    by: 'tomas',
    markdown: `## Week of 26 October
- Design system v2 is in every project now.
- Staging sites rebuild on every merge.
- Next week: start the accessibility audit.`,
  },
  {
    key: 'stack',
    space: 'engineering',
    title: 'Our stack',
    by: 'tomas',
    markdown: `- **Front end:** TypeScript and React, styled with our design system
- **Back end:** Node.js and PostgreSQL
- **Hosting:** one staging and one production site per client
- **Reviews:** every change gets a second pair of eyes before it merges`,
  },
  {
    key: 'release',
    space: 'engineering',
    title: 'Release checklist',
    by: 'jonah',
    markdown: `1. All checks pass on the staging site.
2. The client has signed off on staging.
3. Run the accessibility checks.
4. Release before 15:00, never on a Friday.
5. Post in the client channel when it's live, and watch errors for an hour.`,
  },

  // --- Handbook --------------------------------------------------------------
  {
    key: 'welcome',
    space: 'handbook',
    title: 'Welcome to Northwind',
    markdown: `Northwind Studio is a small product design studio. We design and build websites and apps for companies we like.

## Your first week
- Meet everyone over coffee
- Read the Handbook, starting with Time off and Meeting rhythm
- Shadow a client check-in`,
  },
  {
    key: 'time-off',
    space: 'handbook',
    title: 'Time off',
    markdown: `## Vacation
- New hires get **22 vacation days** a year, plus public holidays.
- After three years, you get 25.
- Ask at least two weeks ahead for anything longer than three days.

## Sick days
- Take what you need and tell your team in the morning.

## Booking
- Add it to the team calendar and tell Priya.`,
  },
  {
    key: 'office',
    space: 'handbook',
    title: 'Office layout',
    markdown: `Our studio is on the second floor of 14 Mill Lane.

- **Open area:** six desks by the windows
- **Meeting room:** seats eight, book it in the calendar
- **Kitchen:** next to the stairs
- We're turning the small store room into a quiet room in November.`,
  },
  {
    key: 'expenses',
    space: 'handbook',
    title: 'Expenses',
    markdown: `- Keep the receipt and upload a photo within a week.
- Travel to a client is always covered.
- Books and courses: up to 500 a year, no need to ask first.`,
  },
  {
    key: 'meetings',
    space: 'handbook',
    title: 'Meeting rhythm',
    markdown: `- **Monday 09:30:** plan the week, 20 minutes
- **Thursday:** client check-ins
- **Friday 14:00:** design review
- Everything else is asynchronous. Write it down in the wiki instead of calling a meeting.`,
  },
];

/** The demo files: a brand guide (PDF) and a budget (XLSX). */
export const brandGuide = {
  name: 'Harbor & Co brand guide.pdf',
  title: 'Harbor & Co brand guide',
  sections: [
    {
      heading: 'Colours',
      body: 'Our primary colour is Tidewater Blue (#1F4E5F). Use Driftwood Sand (#E8DCC4) for backgrounds and Signal Coral (#E4664A) only for buttons and alerts.',
    },
    {
      heading: 'Type',
      body: 'Headlines use a humanist sans at a heavy weight. Body text is never smaller than 16 pixels.',
    },
    {
      heading: 'Photography',
      body: 'Show furniture outdoors in natural light, with people using it. No studio backdrops.',
    },
  ],
};

export const budget = {
  name: 'Q4 budget.xlsx',
  sheets: [
    {
      name: 'Projects',
      rows: [
        ['Project', 'Client', 'Budget', 'Spent'],
        ['Checkout redesign', 'Harbor & Co', 48000, 31500],
        ['Booking flow', 'Lumen Health', 36000, 12800],
        ['Pre-orders', 'Fernwood Bakery', 18000, 0],
        ['Tracking page', 'Atlas Freight', 24000, 0],
      ],
    },
    {
      name: 'Studio',
      rows: [
        ['Item', 'Monthly'],
        ['Rent', 4200],
        ['Software', 860],
        ['Training', 400],
      ],
    },
  ],
};
