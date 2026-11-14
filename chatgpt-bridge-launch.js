/* Adds a shortcut to the optional ChatGPT/GitHub bridge for the room host. */
(() => {
  const roomCard = document.querySelector(".room");
  if (!roomCard) return;
  const row = document.createElement("div");
  row.className = "row";
  const link = document.createElement("a");
  link.className = "btn sm";
  link.href = "chatgpt-bridge.html";
  link.textContent = "Connect ChatGPT";
  link.style.width = "100%";
  link.style.textAlign = "center";
  link.style.textDecoration = "none";
  link.addEventListener("click", event => {
    const room = sessionStorage.getItem("murmur.room");
    const key = sessionStorage.getItem("murmur.inviteToken");
    const name = sessionStorage.getItem("murmur.name");
    if (!room || !key || name !== "You") {
      event.preventDefault();
      const status = document.getElementById("room-label");
      if (status) status.textContent = "Only the room host can launch the ChatGPT bridge.";
      return;
    }
    const target = new URL(link.href, location.href);
    target.hash = new URLSearchParams({ room, key }).toString();
    link.href = target.toString();
    link.target = "_blank";
    link.rel = "noopener";
  });
  row.appendChild(link);
  roomCard.appendChild(row);
})();