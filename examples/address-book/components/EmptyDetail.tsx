import React from "react";

export function EmptyDetail({ missing = false }: { missing?: boolean }) {
  return (
    <div className="empty-detail">
      <p className="empty-detail__mark" aria-hidden="true">
        {missing ? "404" : "＋"}
      </p>
      <h1>{missing ? "Contact not found" : "Select a contact"}</h1>
      <p>
        {missing
          ? "This contact may have been deleted in another session."
          : "Choose someone from the directory or create a new contact."}
      </p>
      <a
        className="button button--primary"
        href={missing ? "/contacts" : "/contacts/new"}
        s-html=""
        data-preserve-query
      >
        {missing ? "Back to directory" : "Create contact"}
      </a>
    </div>
  );
}
