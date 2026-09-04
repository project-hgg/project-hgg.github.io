# Project hGG — Horror Games Mega Metadata

A free, public backup directory for [hoGAMEGATA](https://gamegata.xyz), the most curated horror game catalog in the world.

---

## What is this?

This website is a lightweight backup mirror of the games and creators listed on **hoGAMEGATA**. 

Its purpose is simple: to make sure video game history and indie horror projects are preserved and always easy to find. If you want to browse horror games, find who made them, and see where to play them, you can do so here with zero ads and zero sign-ups.

- **Live Website:** [project-hgg.github.io](https://project-hgg.github.io)
- **Main Game Search Engine/Project Link:** [gamegata.xyz](https://gamegata.xyz)

---

## What is included? (The total number keeps increasing as new games are added frequently!)

- **107,000+ Horror Games:** Organized alphabetically from numbers (0–9) to letters (A–Z). 
- **68,000+ Developers and Studios:** Solo creators, small teams, and major publishers.
- **15,800+ Horror & Gameplay Tags:** Exhaustive tag vocabulary cataloging every subgenre, motif, and mechanic.
- **Store Links:** Direct links to find games on Steam, itch.io, GOG, and hoGAMEGATA.
- **Fast Title Search:** Search through the whole catalog instantly in your web browser.
- **Zero Ads:** Completely free to use, without popups or commercial sponsors.

### Raw Data Dumps & Preservation Files
- [`all-games.txt`](https://raw.githubusercontent.com/project-hgg/project-hgg.github.io/main/all-games.txt) (plain text catalog: Title | Developer | URL)
- [`all-games.md`](https://github.com/project-hgg/project-hgg.github.io/blob/main/all-games.md) (structured Markdown table)
- [`all-tags.txt`](https://raw.githubusercontent.com/project-hgg/project-hgg.github.io/main/all-tags.txt) (raw plain text list of all 15,825 tags: Tag Name | Slug)

---

## How to browse the directory

1. Open [project-hgg.github.io](https://project-hgg.github.io) in your browser.
2. Click **Directory (A-Z)** to start browsing by letter.
3. Click on any game to visit its store page or view its details on hoGAMEGATA.
4. Press the search bar (or Ctrl + K / Cmd + K) to search any game by name.

---

## Running this website on your computer

If you want to view or test this index on your own machine:

1. **Clone this repository:**
   `
   git clone https://github.com/project-hgg/project-hgg.github.io.git
   cd project-hgg.github.io
   `

3. **Install dependencies:**
   `
   npm install
   `

4. **Start local preview:**
   `
   npm run docs:dev
   `
   Open your browser to http://localhost:5173 to browse the site.

5. **Build static files:**
   `
   npm run docs:build
   `

---

## About hoGAMEGATA

hoGAMEGATA is an open, independent database built to catalog and preserve the entire world of horror video games. From retro classics to modern indie releases. 

- **Official Website:** [https://gamegata.xyz](https://gamegata.xyz)

---

## Credits & License

Game titles, trademarks, and cover images belong to their respective creators and publishers. The index layout and data formatting are shared freely for game discovery and preservation.
