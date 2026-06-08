import React from "react";
import { getContactName } from "../db/presentation.js";
import type { Contact } from "../db/types.js";
import { Avatar } from "./Avatar.js";

export function ContactDetail({ contact }: { contact: Contact }) {
  return (
    <article className="contact-detail">
      <header className="detail-toolbar">
        <a
          className="mobile-back"
          href="/contacts"
          s-html=""
          data-preserve-query
        >
          ‹ People
        </a>
        <div className="detail-toolbar__actions">
          <a
            className="button"
            href={`/contacts/${contact.id}/edit`}
            s-html=""
            data-preserve-query
          >
            Edit contact
          </a>
          <form method="post" action="?/delete" data-delete-form>
            <button className="button button--danger" type="submit">
              Delete
            </button>
          </form>
        </div>
      </header>
      <section className="profile">
        <Avatar contact={contact} size="hero" />
        <div className="profile__copy">
          <div className="profile__name">
            <h1>{getContactName(contact)}</h1>
            <form method="post" action="?/favorite" data-favorite-form>
              <input
                type="hidden"
                name="favorite"
                value={contact.favorite ? "false" : "true"}
              />
              <button
                className="favorite-button"
                type="submit"
                aria-label={
                  contact.favorite
                    ? "Remove from favorites"
                    : "Add to favorites"
                }
                aria-pressed={contact.favorite}
              >
                {contact.favorite ? "★" : "☆"}
              </button>
            </form>
          </div>
          <p>
            {[contact.role, contact.company, contact.location]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="profile__links">
            {contact.website ? (
              <a href={contact.website} target="_blank" rel="noreferrer">
                Website
              </a>
            ) : null}
            {contact.handle ? <span>{contact.handle}</span> : null}
          </div>
        </div>
      </section>
      <dl className="contact-info">
        <div>
          <dt>Email</dt>
          <dd>{contact.email || "Not provided"}</dd>
        </div>
        <div>
          <dt>Phone</dt>
          <dd>{contact.phone || "Not provided"}</dd>
        </div>
        <div className="contact-info__notes">
          <dt>Notes</dt>
          <dd>{contact.notes || "No notes yet."}</dd>
        </div>
      </dl>
    </article>
  );
}
