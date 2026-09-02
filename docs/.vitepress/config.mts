import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "hoGAMEGATA Index Mirror",
  description: "A backed-up static index copy of all games registered on hoGAMEGATA.",
  themeConfig: {
    sidebar: false,

    nav: [
      { text: 'Home', link: '/' },
      { text: 'Directory (A-Z)', link: '/directory/A' },
      { text: 'Developers', link: '/developers' },
      { text: 'Main Site', link: 'https://gamegata.xyz' }
    ],

    search: {
      provider: 'local',
      options: {
        detailedView: true
      }
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/project-hgg/project-hgg.github.io' }
    ],

    footer: {
      message: 'Released under Open Data Index format for hoGAMEGATA.',
      copyright: 'Copyright © 2026 hoGAMEGATA'
    }
  }
})
