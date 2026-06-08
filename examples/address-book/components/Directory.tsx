import React from "react";
import type { ContactSummary } from "../db/types.js";
import { getContactName, getContactSearchText } from "../db/presentation.js";
import { Avatar } from "./Avatar.js";

export function Directory({
  contacts,
  selectedId,
  query,
}: {
  contacts: ContactSummary[];
  selectedId?: string;
  query: string;
}) {
  let previousFavorite: boolean | undefined;

  return (
    <aside className="directory" aria-label="Contact directory">
      <div className="directory__header">
        <a className="directory__brand" href="/contacts" s-html="">
          Directory
        </a>
        <a
          className="icon-button icon-button--primary"
          href="/contacts/new"
          s-html=""
          data-preserve-query
          aria-label="Create contact"
        >
          +
        </a>
      </div>
      <label className="search">
        <span className="sr-only">Search people</span>
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search people"
          autoComplete="off"
          data-contact-search-input
        />
      </label>
      <p className="sr-only" aria-live="polite" data-search-status />
      <ul className="directory__list" data-contact-list>
        {contacts.map((contact) => {
          const showSection = previousFavorite !== contact.favorite;
          previousFavorite = contact.favorite;
          return (
            <li
              key={contact.id}
              className="directory__item"
              data-contact-row
              data-search={getContactSearchText(contact)}
            >
              <span
                className="directory__section"
                data-section-label
                data-section={contact.favorite ? "favorites" : "all"}
                hidden={!showSection}
              >
                {contact.favorite ? "Favorites" : "All contacts"}
              </span>
              <a
                className="contact-row"
                href={`/contacts/${contact.id}`}
                s-html=""
                data-preserve-query
                aria-current={selectedId === contact.id ? "page" : undefined}
              >
                <Avatar contact={contact} />
                <span className="contact-row__copy">
                  <strong>{getContactName(contact)}</strong>
                  <small>
                    {[contact.role, contact.company]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </span>
                {contact.favorite ? (
                  <span className="contact-row__favorite" aria-label="Favorite">
                    ★
                  </span>
                ) : null}
              </a>
              <span hidden>
                {contact.email} {contact.handle}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="directory__empty" hidden data-search-empty>
        No contacts match this search.
      </div>
      <footer className="directory__footer">
        <span>{contacts.length} people</span>
        <span>Live updates enabled</span>
      </footer>
    </aside>
  );
}
