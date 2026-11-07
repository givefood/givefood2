function changetab(section) {
    // An empty hash (going Back to the page's bare URL fires hashchange with
    // location.hash "") or one that isn't a valid class name ("#1", "#a b")
    // would make querySelector throw, so escape it and bail out early.
    if (!section) {
        return false
    }
    const selector = "." + CSS.escape(section)
    const panel = document.querySelector(selector)
    if (!panel) {
        // A hash that isn't one of this page's tabs
        return false
    }
    document.querySelectorAll(".tabs li").forEach(item => {
        item.classList.remove("is-active")
    })
    panel.parentNode.classList.add("is-active")

    // Update aria-selected for all tabs
    document.querySelectorAll(".tabs a[role='tab']").forEach(tab => {
        tab.setAttribute("aria-selected", "false")
    })
    
    document.querySelectorAll(".sections .tabcontent").forEach(item => {
        item.classList.add("is-hidden")
    })
    document.querySelectorAll(selector).forEach(item => {
        item.classList.remove("is-hidden")
        // Panels loaded on demand listen for this with hx-trigger="showtab once"
        item.dispatchEvent(new CustomEvent("showtab"))
    })

    const activeTab = document.querySelector("a[data-tab='" + CSS.escape(section) + "']")
    if (activeTab) {
        activeTab.parentNode.classList.add("is-active")
        activeTab.setAttribute("aria-selected", "true")
    }
    
    window.location.hash = section
    return true
}

document.querySelectorAll(".tabs a").forEach(item => {
    item.addEventListener("click", event => {
        changetab(item.dataset.tab)
    })
})

addEventListener("hashchange", (event) => {
    changetab(window.location.hash.replace("#", ""))
})

function opendeeplinkedtab() {
    if (window.location.hash) {
        window.dispatchEvent(new HashChangeEvent("hashchange"))
    }
}

// Wait for DOMContentLoaded so that htmx has wired up its triggers before a
// deep linked tab asks it to load one of the panels. This script is deferred,
// which runs at readyState "interactive", so only "complete" means we have
// already missed the event.
if (document.readyState === "complete") {
    opendeeplinkedtab()
} else {
    addEventListener("DOMContentLoaded", opendeeplinkedtab)
}