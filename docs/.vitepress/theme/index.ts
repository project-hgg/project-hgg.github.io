import DefaultTheme from 'vitepress/theme'
import CustomSearchModal from './CustomSearchModal.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('VPLocalSearchBox', CustomSearchModal)
  }
}
