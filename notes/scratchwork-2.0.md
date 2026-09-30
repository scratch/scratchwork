# Scratchwork 2.0

A collaborative workspace for expressing your ideas

Writer (temp name) is a collaborative workspace in which humans and agents work together to express and share ideas. I'm imagining a tool with the ergonomics of Google docs for writing and sharing, but that allows for the full expressive power of agents that can write html and javascript.

The components I imagine are:

- a surface for rendering arbitrary html & JS that includes a simple, elegant text editor designed for humans to write and edit text. multiple people and agents can edit a document together in realtime; conflicting edits should be resolved either in a deterministic way or by an arbiter agent
- an embedded agent that can do everything that a human, or an independent agent, can do with a document
- an api, mcp or cli (both?) that an agent can use to publish and edit documents
- a sharing mechanism and UI for sharing a document with others. Others can have read, write, or owner permissions. a project must always have at least one owner.



## Things I want to be able to do with this tool

1. Use my own agent (e.g. claude code) to create and publish documents built with arbitrary html and JS
2. Use an embedded agent to create or edit a document live in the writer web app
3. Write or edit text in my documents by hand.
4. See where other human authors are editing in real time 
5. See where agent authors are editing in real time (not sure about how this one!)

scratchwork as it exists today does *some* of this well, but lacks a collaborative editor. The editor will be difficult to build for a few reasons: first, collaborative realtime editors are tricky to get right in general, and this one will be no exception. Second, and perhaps more importantly, text editors in the past have been built for specific and very narrow document formats, like MS word or Google Docs/Slides. I want this editor to allow me as a human to edit the text in my arbitrary html/js agent creations! 

This will probably require us to come up with a way for a document to "register" editable text with the editor, and for the editor to update the document in such a way that the editable text remains valid.

We may need to make tradoffs in order to build a usable tool that feels good in the (human) hand. For example, one tradeoff that we could make is to devise a document format similar to .mdx, in which react components are embedded in markdown text, and then make the "outer" text editable by hand while strings in embedded react components are not. Alternatively a document could conatain and export a data structure for human-editable text. In this case agents would presumably need instruction on how to build this datastructure and a way to validate it.
